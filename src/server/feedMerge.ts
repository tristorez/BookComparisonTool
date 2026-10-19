/**
 * Merges one quote's reports from several feeds (Box A, Box B) into the single value the board
 * shows (Decisions.txt D-35). Pure: callers pass the clock and each feed's health.
 *
 * A "feed" here is one observation stream that only moves forward: one channel (push, poll or
 * snapshot) of one box, fed from the connectors' per-channel `sample` events. Streams run at different
 * speeds, so a slower one re-reports states the board already showed. `knownAt` is the latest moment
 * the shown state is known to have been in effect at the book.
 *
 * Precise reports (polls, snapshots, DK pushes with ms timestamps) are ordered by time:
 *  - same value as shown → a confirmation (unless a DK timestamp proves it is an earlier occurrence);
 *  - observed before `knownAt` → older → rejected;
 *  - otherwise → a newer observation → shown (first copy wins).
 * FD pushes carry whole-second timestamps, too coarse to order changes within a second. A push channel
 * reports every change in order, so its report is the first occurrence of that value after the last
 * state the channel reported:
 *  - that occurrence is the shown one → a confirmation;
 *  - an earlier one → a late copy from a lagging channel → rejected;
 *  - none (a value not shown since) → ordered by time as above.
 * Dropping an ambiguous FD push costs little: polls (two boxes, every 0.5 s) report it within ~0.5 s.
 * (Matching by value can't prove a channel is in sync with the shown occurrence, since the board skips
 * states when a poll leads, so there is deliberately no "in sync, accept the next change" shortcut.)
 * Simulated over 400 runs with bursts and dropped frames: no rollbacks; ~3% of FD states shown
 * ~0.2-0.5 s after their first (ambiguous) arrival.
 * A once-a-second sweep heals any remaining wrong rejection (every healthy feed has held the same other
 * state for 3 s) and fails over when the feed behind the shown value becomes unhealthy.
 */
import type { Channel, FeedId } from '../shared/domain.js';

export interface QuoteState {
  american: number;
  line: number | null;
  suspended: boolean;
  live: boolean;
}

export interface FeedReport {
  feed: FeedId;
  state: QuoteState;
  /** Book's change timestamp, when the channel carries one. */
  bookTime: number | null;
  /** When this feed received the value (its own clock; boxes are chrony-synced). */
  receivedAt: number;
  channel: Channel;
}

export interface MergedValue extends QuoteState {
  feed: FeedId;
  bookTime: number | null;
  receivedAt: number;
  channel: Channel;
  /** When the board accepted this value. */
  at: number;
  /** Previous shown price/line; set only when the price or line moved. */
  prev?: { american: number; line: number | null; at: number };
}

export type MergeCause = 'new' | 'heal' | 'failover';

export type MergeResult =
  | { kind: 'accepted'; value: MergedValue; cause: MergeCause }
  | { kind: 'duplicate'; lagMs: number | null }
  | { kind: 'rejected'; reason: 'older' | 'late-copy' }
  | { kind: 'removed' }
  | { kind: 'none' };

export interface MergeConfig {
  /** Resolution of this book's timestamps: DK createdTime is exact (0); FD updatedAt is whole seconds (1000). */
  bookTimeResolutionMs: number;
  /** A sweep adopts a state every healthy feed has held this long (default 3000). */
  healAfterMs?: number;
  /** Shown states remembered for late-copy detection (default 64). */
  historyLimit?: number;
}

/**
 * Feeds are named `<box>:<channel>`. A push channel that has not reported yet starts where its box's
 * snapshot left it: the connector emits its snapshot before any push.
 */
const snapshotFeedOf = (feed: FeedId): FeedId => `${feed.split(':')[0]}:snapshot`;

export const stateSig = (s: QuoteState): string => `${s.american}|${s.line}|${s.suspended ? 1 : 0}|${s.live ? 1 : 0}`;

/**
 * When a report's state is known to have been in effect: a book timestamp marks the change itself
 * (FD's is floored to the second, so this errs early); without one, the receive time backed off by
 * how stale the channel can be: a poll is answered ~RTT/2 before it lands (SMP ~12 ms from us-east-2),
 * DK's REST snapshot is edge-cached for ~1 s.
 */
function inEffectAt(r: FeedReport): number {
  if (r.bookTime !== null) return r.bookTime;
  return r.receivedAt - (r.channel === 'snapshot' ? 2_000 : r.channel === 'poll' ? 50 : 1_000);
}

interface HistoryEntry {
  sig: string;
  idx: number;
}

export class QuoteMerge {
  private current: MergedValue | null = null;
  private currentSig = '';
  /** Latest moment the shown state is known to have been in effect at the book. */
  private knownAt = -Infinity;
  private readonly history: HistoryEntry[] = [];
  private nextIdx = 0;
  /** History index of the state each feed last reported or confirmed. */
  private readonly feedPos = new Map<FeedId, number>();
  /** Each feed's latest report and since when it has held that state. */
  private readonly feedLast = new Map<FeedId, { report: FeedReport; sig: string; since: number }>();
  /** Feeds that currently list this quote. */
  private readonly present = new Set<FeedId>();
  /** Feeds that have already confirmed the shown state (for second-copy lag, counted once). */
  private confirmedBy = new Set<FeedId>();

  constructor(private readonly cfg: MergeConfig) {}

  get value(): MergedValue | null {
    return this.current;
  }

  /** Feeds currently listing this quote. */
  get feeds(): ReadonlySet<FeedId> {
    return this.present;
  }

  report(r: FeedReport, now: number): MergeResult {
    const sig = stateSig(r.state);
    this.present.add(r.feed);
    const last = this.feedLast.get(r.feed);
    this.feedLast.set(r.feed, { report: r, sig, since: last?.sig === sig ? last.since : now });
    if (!this.current) return this.accept(r, sig, now, 'new');
    // A feed repeating its last state is another delivery of one observation (a box reports each as a
    // sample and as a change; a resync re-sends it). Its first delivery was judged already; judging it
    // again can't add anything, and after a late-copy match has moved the feed's position past that
    // occurrence it would fall through and could put an old price back on screen.
    if (last?.sig === sig) return { kind: 'duplicate', lagMs: null };

    const t = inEffectAt(r);
    const coarse = r.bookTime !== null && this.cfg.bookTimeResolutionMs > 0;
    const pos = this.feedPos.get(r.feed) ?? (coarse ? this.feedPos.get(snapshotFeedOf(r.feed)) : undefined);
    if (coarse && pos !== undefined) {
      const match = this.history.find((e) => e.sig === sig && e.idx > pos);
      if (match && match.idx !== this.headIdx()) {
        this.feedPos.set(r.feed, match.idx);
        return { kind: 'rejected', reason: 'late-copy' };
      }
      if (match) return this.confirm(r, t);
    }
    if (sig === this.currentSig) {
      // A DK timestamp before the shown occurrence's start is an earlier occurrence of the same value.
      if (!coarse && r.bookTime !== null && r.bookTime < this.knownAt) return { kind: 'rejected', reason: 'older' };
      return this.confirm(r, t);
    }
    if (t < this.knownAt) return { kind: 'rejected', reason: 'older' };
    return this.accept(r, sig, now, 'new');
  }

  private confirm(r: FeedReport, t: number): MergeResult {
    const cur = this.current!;
    this.knownAt = Math.max(this.knownAt, t);
    this.feedPos.set(r.feed, this.headIdx());
    if (r.feed === cur.feed || this.confirmedBy.has(r.feed)) return { kind: 'duplicate', lagMs: null };
    this.confirmedBy.add(r.feed);
    // A snapshot re-sends values with their original receive times, so it says nothing about the race.
    if (r.channel === 'snapshot' || cur.channel === 'snapshot') return { kind: 'duplicate', lagMs: null };
    return { kind: 'duplicate', lagMs: r.receivedAt - cur.receivedAt };
  }

  /** A feed stopped listing this quote. Gone for good once no healthy feed lists it. */
  remove(feed: FeedId, healthy: (f: FeedId) => boolean, now: number): MergeResult {
    this.present.delete(feed);
    this.feedLast.delete(feed);
    this.feedPos.delete(feed);
    if (!this.current) return { kind: 'none' };
    const live = [...this.present].filter(healthy);
    if (live.length) return this.current.feed === feed ? this.handOver(live, now) : { kind: 'none' };
    // No healthy feed lists it. An unhealthy feed dropping it while other (unhealthy) feeds still
    // list it proves nothing, so keep the last value on screen; it is marked stale.
    if (!healthy(feed) && this.present.size) return { kind: 'none' };
    return this.drop();
  }

  /**
   * Periodic repair. `anyHealthy` says whether the book has any healthy feed at all: without one the
   * last value stays on screen (marked stale) instead of being removed.
   */
  sweep(healthy: (f: FeedId) => boolean, now: number, anyHealthy = true): MergeResult {
    const live = [...this.present].filter(healthy);
    if (!this.current) {
      const newest = this.newestOf(live);
      return newest ? this.accept(newest.report, newest.sig, now, 'failover') : { kind: 'none' };
    }
    // The book's healthy feeds don't list it (only unhealthy ones do, or none): it's gone. With no
    // healthy feed at all, keep the last value on screen; the book is marked stale.
    if (!live.length) return anyHealthy ? this.drop() : { kind: 'none' };

    // Failover: the feed behind the shown value is unhealthy; take the freshest healthy view.
    if (!healthy(this.current.feed)) return this.handOver(live, now);

    // Heal: every healthy feed has agreed on another state for a while (e.g. a genuine revert that
    // rule 3 took for a late copy because no book timestamp was available).
    const views = live.map((f) => this.feedLast.get(f)).filter((v): v is NonNullable<typeof v> => !!v);
    if (views.length !== live.length || !views.length) return { kind: 'none' };
    const sig = views[0]!.sig;
    if (sig === this.currentSig || views.some((v) => v.sig !== sig)) return { kind: 'none' };
    if (Math.max(...views.map((v) => v.since)) > now - (this.cfg.healAfterMs ?? 3_000)) return { kind: 'none' };
    const newest = views.reduce((a, b) => (inEffectAt(b.report) > inEffectAt(a.report) ? b : a));
    return this.accept(newest.report, sig, now, 'heal');
  }

  private accept(r: FeedReport, sig: string, now: number, cause: MergeCause): MergeResult {
    const before = this.current;
    const moved = !!before && (before.american !== r.state.american || before.line !== r.state.line);
    this.current = {
      ...r.state,
      feed: r.feed,
      bookTime: r.bookTime,
      receivedAt: r.receivedAt,
      channel: r.channel,
      at: now,
      prev: moved ? { american: before!.american, line: before!.line, at: now } : before?.prev,
    };
    this.currentSig = sig;
    this.knownAt = inEffectAt(r);
    const idx = this.nextIdx++;
    this.history.push({ sig, idx });
    if (this.history.length > (this.cfg.historyLimit ?? 64)) this.history.shift();
    this.feedPos.set(r.feed, idx);
    this.confirmedBy = new Set([r.feed]);
    return { kind: 'accepted', value: this.current, cause };
  }

  /** The shown value's feed is gone or unhealthy: switch to the freshest healthy view. */
  private handOver(live: FeedId[], now: number): MergeResult {
    const newest = this.newestOf(live);
    if (!newest) return { kind: 'none' };
    if (newest.sig !== this.currentSig) return this.accept(newest.report, newest.sig, now, 'failover');
    this.current = { ...this.current!, feed: newest.report.feed };
    return { kind: 'none' };
  }

  private drop(): MergeResult {
    this.current = null;
    this.currentSig = '';
    this.knownAt = -Infinity;
    return { kind: 'removed' };
  }

  private headIdx(): number {
    return this.history.at(-1)?.idx ?? -1;
  }

  private newestOf(feeds: FeedId[]): { report: FeedReport; sig: string } | null {
    let best: { report: FeedReport; sig: string } | null = null;
    for (const f of feeds) {
      const v = this.feedLast.get(f);
      if (v && (!best || inEffectAt(v.report) > inEffectAt(best.report))) best = v;
    }
    return best;
  }
}
