/**
 * The board: one in-memory view of every book, merged from every feed (Decisions.txt D-24, D-25, D-35).
 *
 * Inputs, per feed (one box × one book): the connector's per-channel `sample` events (quote values),
 * `change` events (games, removals, and quote values again, which re-add a quote after a removal), and
 * its status. Each quote's value comes from a QuoteMerge over every box's channels. Outputs: one
 * `delta` per event-loop turn (coalesced with setImmediate, never time-batched), each with a
 * consecutive `seq`, plus a ring of recent deltas for SSE resume.
 *
 * Handlers never throw back into a connector (they run inside socket and poll callbacks): every entry
 * point is wrapped and failures are counted.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { NFL_TEAMS } from '../books/teams.js';
import type { BookChange, BookGame, BookStatus, QuoteRef, QuoteSample } from '../books/types.js';
import { bestOf, type BestOptions, type GameOffers } from '../shared/bestPrice.js';
import { MARKET_SIDES, MARKETS, type BookId, type Channel, type ConnectionState, type MarketType, type Side } from '../shared/domain.js';
import { americanToDecimal, isValidAmerican } from '../shared/odds.js';
import { cellKey, quoteKey, type Delta, type Snapshot, type WireBest, type WireBookStatus, type WireGame, type WireQuote } from '../shared/wire.js';
import { QuoteMerge, type MergeResult, type MergedValue } from './feedMerge.js';
import type { LatencyTracker } from './latency.js';
import type { BookSpec } from './registry.js';

const CHANNELS: readonly Channel[] = ['push', 'poll', 'snapshot'];
const STATE_RANK: Record<ConnectionState, number> = { live: 0, degraded: 1, connecting: 2, down: 3, stopped: 4 };
const TEAM_NAMES = new Map(NFL_TEAMS.map((t) => [t.code, t.name]));

const WATCHDOG_EVERY_MS = 10_000;
const FROZEN_WINDOW_MS = 90_000;
const FROZEN_OTHER_MIN_CHANGES = 5;
const RESTART_COOLDOWN_MS = 5 * 60_000;
const MASS_REMOVAL_MIN = 12;
const MASS_REMOVAL_SHARE = 0.3;
const MASS_REMOVAL_HOLD_MS = 15_000;
const SANITY_MAX_GAP = 0.2;
const SANITY_MAX_LINE_DIFF = 1.5;

export interface BoardOptions {
  /** Registry entries, in display order. */
  books: BookSpec[];
  staleGraceMs: number;
  staleAfterMs?: Partial<Record<BookId, number>>;
  ringSize?: number;
  latency?: LatencyTracker;
  best?: BestOptions;
  now?: () => number;
  log?: (msg: string) => void;
  /** How a flush is deferred; setImmediate by default (one delta per event-loop turn). */
  defer?: (fn: () => void) => void;
}

export interface FeedSource {
  /** Current connector status (its `lastDataAt` moves silently, so it is read on every tick). */
  getStatus(): BookStatus;
  /** Restart a frozen feed; for a remote feed this goes over the feed link. */
  restart?(): void | Promise<void>;
}

/** What a feed's owner calls when its connector (or the feed link) emits. */
export interface FeedHandle {
  change(c: BookChange): void;
  samples(s: QuoteSample[]): void;
  status(s: BookStatus): void;
  /** Remote feeds: the feed link went down/up. Local feeds are always linked. */
  setLinked(up: boolean): void;
}

interface FeedState {
  box: string;
  book: BookId;
  source: FeedSource;
  status: BookStatus;
  linked: boolean;
  everHealthy: boolean;
  staleSince: number | null;
  stale: boolean;
  frozen: boolean;
  attachedAt: number;
  lastRestartAt: number;
  games: Map<string, BookGame>;
  /** Quote keys this feed currently lists. */
  keys: Set<string>;
  /** When this feed reported a live quote (any outcome), for the frozen-feed watchdog. */
  liveActivity: number[];
  held: { refs: QuoteRef[]; at: number; relisted: Set<string> } | null;
}

interface Counters {
  aggregatorErrors: number;
  invalidQuotes: number;
  olderRejected: number;
  lateCopies: number;
  heals: number;
  failovers: number;
  massRemovalsHeld: number;
  watchdogFreezes: number;
  watchdogRestarts: number;
  rebinds: number;
}

export class Board extends EventEmitter<{ delta: [Delta] }> {
  readonly boot = randomUUID().slice(0, 8);
  private seqNo = 0;
  private readonly ring: Delta[] = [];
  private readonly now: () => number;
  private readonly defer: (fn: () => void) => void;
  private readonly log: (msg: string) => void;
  private readonly books: BookSpec[];

  private readonly feeds = new Map<string, FeedState>();
  private readonly merges = new Map<string, QuoteMerge>();
  /** What clients have: the state as of `seq`, used for snapshots. */
  private readonly gamesSent = new Map<string, WireGame>();
  private readonly quotesSent = new Map<string, WireQuote>();
  private readonly bestsSent = new Map<string, WireBest>();
  private readonly statusSent = new Map<BookId, WireBookStatus>();
  private readonly suspect = new Set<string>();
  private readonly lastChangeAt = new Map<BookId, number>();

  private readonly pending = {
    quotes: new Map<string, WireQuote>(),
    removedQuotes: new Set<string>(),
    games: new Set<string>(),
    /** `game|market` → why it needs a best-price recompute. */
    markets: new Map<string, 'price' | 'eligibility'>(),
    status: new Set<BookId>(),
  };
  private scheduled = false;
  private lastWatchdog = 0;
  private snapshotCache: { seq: number; json: string } | null = null;
  readonly counters: Counters = {
    aggregatorErrors: 0,
    invalidQuotes: 0,
    olderRejected: 0,
    lateCopies: 0,
    heals: 0,
    failovers: 0,
    massRemovalsHeld: 0,
    watchdogFreezes: 0,
    watchdogRestarts: 0,
    rebinds: 0,
  };

  constructor(private readonly opts: BoardOptions) {
    super();
    this.books = opts.books;
    this.now = opts.now ?? Date.now;
    this.defer = opts.defer ?? ((fn) => setImmediate(fn));
    this.log = opts.log ?? (() => {});
  }

  get seq(): number {
    return this.seqNo;
  }

  // ------------------------------------------------------------------------------------- feeds

  /** Register a feed. Call before the connector starts: connectors emit during `start()`. */
  addFeed(box: string, book: BookId, source: FeedSource): FeedHandle {
    const key = `${box}/${book}`;
    if (this.feeds.has(key)) throw new Error(`feed ${key} already attached`);
    const f: FeedState = {
      box,
      book,
      source,
      status: source.getStatus(),
      linked: true,
      everHealthy: false,
      staleSince: null,
      stale: true,
      frozen: false,
      attachedAt: this.now(),
      lastRestartAt: 0,
      games: new Map(),
      keys: new Set(),
      liveActivity: [],
      held: null,
    };
    this.feeds.set(key, f);
    this.evaluateFeed(f, f.attachedAt);
    this.pending.status.add(book);
    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (err) {
        this.counters.aggregatorErrors++;
        this.log(`board error on ${key}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    };
    return {
      change: (c) => guard(() => this.onChange(f, c)),
      samples: (s) => guard(() => this.onSamples(f, s)),
      status: (s) =>
        guard(() => {
          const now = this.now();
          if (this.evaluateFeed(f, now, () => (f.status = s))) this.onHealthFlip(book, now);
          this.pending.status.add(book);
          this.schedule();
        }),
      setLinked: (up) =>
        guard(() => {
          const now = this.now();
          if (this.evaluateFeed(f, now, () => (f.linked = up))) this.onHealthFlip(book, now);
          this.pending.status.add(book);
          this.schedule();
        }),
    };
  }

  /** Once a second: feed health, watchdog, merge sweeps, held removals. Call from a timer. */
  tick(): void {
    const now = this.now();
    try {
      const flipped = new Set<BookId>();
      for (const f of this.feeds.values()) {
        if (this.evaluateFeed(f, now, () => (f.status = f.source.getStatus()))) flipped.add(f.book);
        f.liveActivity = f.liveActivity.filter((t) => now - t <= FROZEN_WINDOW_MS);
        this.releaseHeld(f, now);
      }
      if (now - this.lastWatchdog >= WATCHDOG_EVERY_MS) {
        this.lastWatchdog = now;
        for (const book of this.watchdog(now)) flipped.add(book);
      }
      for (const spec of this.books) this.sweepBook(spec.id, now);
      for (const book of flipped) this.markBook(book, 'eligibility');
      for (const spec of this.books) if (!sameStatus(this.bookStatus(spec.id), this.statusSent.get(spec.id))) this.pending.status.add(spec.id);
      this.schedule();
    } catch (err) {
      this.counters.aggregatorErrors++;
      this.log(`board tick error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }

  private healthy = (f: FeedState): boolean => !f.stale && !f.frozen && f.linked;

  /** A feed became (un)healthy: re-run failover for its quotes and recompute the book's eligibility. */
  private onHealthFlip(book: BookId, now: number): void {
    this.sweepBook(book, now);
    this.markBook(book, 'eligibility');
  }

  private feedsOf(book: BookId): FeedState[] {
    return [...this.feeds.values()].filter((f) => f.book === book);
  }

  private anyHealthy(book: BookId): boolean {
    return this.feedsOf(book).some(this.healthy);
  }

  /** QuoteMerge feeds are `<box>:<channel>`; health is per box. */
  private mergeHealth(book: BookId): (feed: string) => boolean {
    return (feed) => {
      const f = this.feeds.get(`${feed.split(':')[0]}/${book}`);
      return !!f && this.healthy(f);
    };
  }

  /**
   * Apply a new input (status, link) and recompute the feed's staleness; true when its health flipped.
   * The input is applied here, after `was` is read: `healthy` depends on `linked` directly.
   */
  private evaluateFeed(f: FeedState, now: number, apply?: () => void): boolean {
    const was = this.healthy(f);
    apply?.();
    const staleAfter = this.opts.staleAfterMs?.[f.book] ?? this.books.find((b) => b.id === f.book)!.staleAfterMs;
    const s = f.status;
    const bad = !f.linked || s.state === 'connecting' || s.state === 'down' || s.state === 'stopped' || s.lastDataAt === null || now - s.lastDataAt > staleAfter;
    if (!bad) {
      f.everHealthy = true;
      f.staleSince = null;
      f.stale = false;
    } else {
      f.staleSince ??= now;
      // Grace only for a feed that was healthy (a DK reconnect is live again in ~0.25-0.55 s); never-live,
      // stopped and unlinked feeds are stale at once.
      f.stale = !f.everHealthy || !f.linked || s.state === 'stopped' || now - f.staleSince >= this.opts.staleGraceMs;
    }
    const flipped = was !== this.healthy(f);
    if (flipped) this.log(`feed ${f.box}/${f.book} ${this.healthy(f) ? 'healthy' : `unhealthy (${f.frozen ? 'frozen' : !f.linked ? 'link down' : (s.detail ?? s.state)})`}`);
    return flipped;
  }

  // ------------------------------------------------------------------------------------- inputs

  private onSamples(f: FeedState, samples: QuoteSample[]): void {
    const now = this.now();
    const latency = this.opts.latency;
    for (const s of samples) {
      if (latency && s.bookTime !== null && s.channel !== 'snapshot') {
        // Unbiased per-channel latency: every channel's own observation, not only the race winner's.
        const labels = { book: f.book, phase: s.live ? ('live' as const) : ('pre' as const), channel: s.channel, feed: f.box };
        latency.record('channelBookToServer', labels, s.receivedAt - s.bookTime);
        // DraftKings stamps its own pipeline: engine → publish → socket gateway → us.
        if (s.publishedAt !== null) latency.record('dkEngineToPublish', labels, s.publishedAt - s.bookTime);
        if (s.gatewayAt !== null) latency.record('dkGatewayToServer', labels, s.receivedAt - s.gatewayAt);
      }
      this.report(f, s.gameKey, s.market, s.side, s, s.channel, now);
    }
    this.schedule();
  }

  private onChange(f: FeedState, c: BookChange): void {
    const now = this.now();
    for (const g of c.games) {
      const prev = f.games.get(g.gameKey);
      if (prev && prev.bookEventId !== g.bookEventId) this.counters.rebinds++;
      f.games.set(g.gameKey, g);
      this.pending.games.add(g.gameKey);
    }
    for (const gk of c.removedGames) {
      f.games.delete(gk);
      this.pending.games.add(gk);
    }
    // Quote values usually arrived as samples already (duplicates here are cheap); this path re-adds
    // a quote after a removal, since a channel does not re-sample a value it already reported.
    for (const q of c.quotes) this.report(f, q.gameKey, q.market, q.side, q, q.channel, now);

    const removals = c.removedQuotes;
    // Only a healthy feed's mass removal is suspicious: an unhealthy one (e.g. a feed box that just
    // restarted and sent an empty snapshot) does not drive what is shown anyway.
    if (this.healthy(f) && removals.length >= MASS_REMOVAL_MIN && removals.length > MASS_REMOVAL_SHARE * f.keys.size && !f.held) {
      // A book pulling a third of its board at once is more likely a bad payload than reality.
      f.held = { refs: removals, at: now, relisted: new Set() };
      this.counters.massRemovalsHeld++;
      this.log(`feed ${f.box}/${f.book}: holding mass removal of ${removals.length}/${f.keys.size} quotes for ${MASS_REMOVAL_HOLD_MS / 1000}s`);
    } else {
      for (const ref of removals) this.removeQuote(f, ref, now);
    }
    this.schedule();
  }

  private report(f: FeedState, game: string, market: MarketType, side: Side, v: { american: number; line: number | null; suspended: boolean; live: boolean; bookTime: number | null; receivedAt: number }, channel: Channel, now: number): void {
    if (!isValidAmerican(v.american) || (market !== 'moneyline' && (v.line === null || !Number.isFinite(v.line)))) {
      this.counters.invalidQuotes++;
      return;
    }
    const key = quoteKey(f.book, game, market, side);
    f.keys.add(key);
    f.held?.relisted.add(key);
    if (v.live) f.liveActivity.push(now);
    let merge = this.merges.get(key);
    if (!merge) this.merges.set(key, (merge = new QuoteMerge({ bookTimeResolutionMs: this.spec(f.book).bookTimeResolutionMs })));
    const res = merge.report(
      { feed: `${f.box}:${channel}`, state: { american: v.american, line: v.line, suspended: v.suspended, live: v.live }, bookTime: v.bookTime, receivedAt: v.receivedAt, channel },
      now,
    );
    this.handle(f.book, key, res, now);
  }

  private removeQuote(f: FeedState, ref: QuoteRef, now: number): void {
    const key = quoteKey(f.book, ref.gameKey, ref.market, ref.side);
    f.keys.delete(key);
    const merge = this.merges.get(key);
    if (!merge) return;
    const health = this.mergeHealth(f.book);
    for (const ch of CHANNELS) this.handle(f.book, key, merge.remove(`${f.box}:${ch}`, health, now), now);
  }

  private releaseHeld(f: FeedState, now: number): void {
    if (!f.held || now - f.held.at < MASS_REMOVAL_HOLD_MS) return;
    const { refs, relisted } = f.held;
    f.held = null;
    let applied = 0;
    for (const ref of refs) {
      if (relisted.has(quoteKey(f.book, ref.gameKey, ref.market, ref.side))) continue;
      this.removeQuote(f, ref, now);
      applied++;
    }
    this.log(`feed ${f.box}/${f.book}: released held removal, applied ${applied}/${refs.length}`);
  }

  private sweepBook(book: BookId, now: number): void {
    const health = this.mergeHealth(book);
    const anyHealthy = this.anyHealthy(book);
    const prefix = `${book}|`;
    for (const [key, merge] of this.merges) if (key.startsWith(prefix)) this.handle(book, key, merge.sweep(health, now, anyHealthy), now);
  }

  private handle(book: BookId, key: string, res: MergeResult, now: number): void {
    const [, game, market] = key.split('|') as [BookId, string, MarketType, Side];
    switch (res.kind) {
      case 'accepted': {
        const v = res.value;
        const moved = v.prev?.at === v.at;
        this.pending.quotes.set(key, this.toWire(key, v, res.cause === 'new'));
        this.pending.removedQuotes.delete(key);
        this.pending.games.add(game);
        // Only a real price/line move flashes; suspension or live flips are eligibility changes.
        this.markMarket(game, market, res.cause === 'new' && moved ? 'price' : 'eligibility');
        this.lastChangeAt.set(book, now);
        if (res.cause === 'heal') this.counters.heals++;
        if (res.cause === 'failover') this.counters.failovers++;
        if (res.cause === 'new' && v.channel !== 'snapshot') {
          const box = v.feed.split(':')[0]!;
          this.opts.latency?.firstCopy(book, box);
          if (v.bookTime !== null && moved) {
            this.opts.latency?.record('bookToServer', { book, phase: v.live ? 'live' : 'pre', channel: v.channel, feed: box }, v.receivedAt - v.bookTime);
          }
        }
        break;
      }
      case 'duplicate':
        if (res.lagMs !== null) this.opts.latency?.record('secondCopyLag', { book }, res.lagMs);
        break;
      case 'rejected':
        if (res.reason === 'older') this.counters.olderRejected++;
        else this.counters.lateCopies++;
        break;
      case 'removed':
        this.pending.quotes.delete(key);
        this.pending.removedQuotes.add(key);
        this.pending.games.add(game);
        this.markMarket(game, market, 'eligibility');
        this.lastChangeAt.set(book, now);
        break;
      case 'none':
        break;
    }
  }

  private toWire(key: string, v: MergedValue, allowPrev: boolean): WireQuote {
    const [book, game, market, side] = key.split('|') as [BookId, string, MarketType, Side];
    // A heal or failover is not a market move: suppress a fresh `prev` so the UI does not flash.
    const prev = v.prev && (allowPrev || v.prev.at !== v.at) ? v.prev : undefined;
    return {
      book,
      game,
      market,
      side,
      line: v.line,
      american: v.american,
      suspended: v.suspended,
      live: v.live,
      bt: v.bookTime,
      rx: v.receivedAt,
      ch: v.channel,
      feed: v.feed.split(':')[0]!,
      ...(prev ? { prev } : {}),
    };
  }

  private markMarket(game: string, market: MarketType, why: 'price' | 'eligibility'): void {
    const key = `${game}|${market}`;
    if (this.pending.markets.get(key) !== 'price') this.pending.markets.set(key, why);
  }

  private markGame(game: string, why: 'price' | 'eligibility'): void {
    for (const m of MARKETS) this.markMarket(game, m, why);
  }

  private markBook(book: BookId, why: 'price' | 'eligibility'): void {
    this.pending.status.add(book);
    const games = new Set<string>();
    for (const key of this.merges.keys()) if (key.startsWith(`${book}|`)) games.add(key.split('|')[1]!);
    for (const g of games) this.markGame(g, why);
  }

  // ------------------------------------------------------------------------------------- watchdog

  /** A feed that stops changing while its peer keeps moving live prices is frozen: exclude, restart. */
  private watchdog(now: number): Set<BookId> {
    const flipped = new Set<BookId>();
    const anyLive = [...this.gamesSent.values()].some((g) => g.live);
    for (const f of this.feeds.values()) {
      if (f.frozen && f.liveActivity.length) {
        f.frozen = false;
        flipped.add(f.book);
        this.log(`feed ${f.box}/${f.book}: moving again, unfrozen`);
        continue;
      }
      if (f.frozen || !anyLive || now - f.attachedAt < FROZEN_WINDOW_MS || f.stale || !f.linked) continue;
      const peerMoving = this.feedsOf(f.book).some((o) => o !== f && this.healthy(o) && o.liveActivity.length >= FROZEN_OTHER_MIN_CHANGES);
      if (f.liveActivity.length === 0 && peerMoving) {
        f.frozen = true;
        flipped.add(f.book);
        this.counters.watchdogFreezes++;
        this.log(`feed ${f.box}/${f.book}: no live price changes for ${FROZEN_WINDOW_MS / 1000}s while its peer moves; excluded as frozen`);
        if (f.source.restart && now - f.lastRestartAt >= RESTART_COOLDOWN_MS) {
          f.lastRestartAt = now;
          this.counters.watchdogRestarts++;
          void Promise.resolve(f.source.restart()).catch((err: unknown) => this.log(`restart of ${f.box}/${f.book} failed: ${String(err)}`));
        }
      }
    }
    return flipped;
  }

  // ------------------------------------------------------------------------------------- output

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.defer(() => this.flush());
  }

  /** Build and emit one delta from everything pending. */
  flush(): void {
    this.scheduled = false;
    const now = this.now();
    try {
      const delta: Delta = { seq: 0, ts: now };

      // Games first: a live flip or a sanity flag changes best-price eligibility.
      const games: WireGame[] = [];
      const removedGames: string[] = [];
      for (const gk of this.pending.games) {
        const prev = this.gamesSent.get(gk);
        const next = this.wireGame(gk);
        if (!next) {
          if (prev) {
            removedGames.push(gk);
            this.gamesSent.delete(gk);
            for (const m of MARKETS) for (const side of MARKET_SIDES[m]) this.bestsSent.delete(cellKey(gk, m, side));
          }
          continue;
        }
        if (prev && prev.live !== next.live) this.markGame(gk, 'eligibility');
        if (!prev || JSON.stringify(prev) !== JSON.stringify(next)) {
          this.gamesSent.set(gk, next);
          games.push(next);
        }
      }

      // Cross-book sanity (pregame): a big no-vig gap at near-identical lines is likely a mapping error.
      for (const key of [...this.pending.markets.keys()]) {
        const gk = key.slice(0, key.lastIndexOf('|'));
        const game = this.gamesSent.get(gk);
        if (!game) continue;
        const suspect = !game.live && this.looksSuspect(gk);
        if (suspect !== this.suspect.has(gk)) {
          if (suspect) this.suspect.add(gk);
          else this.suspect.delete(gk);
          this.log(`game ${gk}: ${suspect ? 'flagged suspect (books disagree beyond plausibility)' : 'suspect flag cleared'}`);
          const next = { ...game, ...(suspect ? { suspect: true } : {}) };
          if (!suspect) delete next.suspect;
          this.gamesSent.set(gk, next);
          const i = games.findIndex((g) => g.key === gk);
          if (i >= 0) games[i] = next;
          else games.push(next);
          this.markGame(gk, 'eligibility');
        }
      }

      const quotes = [...this.pending.quotes.values()];
      for (const q of quotes) this.quotesSent.set(quoteKey(q.book, q.game, q.market, q.side), q);
      const removedQuotes = [...this.pending.removedQuotes];
      for (const k of removedQuotes) this.quotesSent.delete(k);

      const bests: WireBest[] = [];
      for (const [key, why] of this.pending.markets) {
        const i = key.lastIndexOf('|');
        const gk = key.slice(0, i);
        const market = key.slice(i + 1) as MarketType;
        if (!this.gamesSent.has(gk)) continue;
        for (const b of this.computeBests(gk, market, why)) {
          const ck = cellKey(gk, market, b.side);
          const prev = this.bestsSent.get(ck);
          if (prev && sameBest(prev, b)) continue;
          this.bestsSent.set(ck, b);
          bests.push(b);
        }
      }

      const status: WireBookStatus[] = [];
      for (const book of this.pending.status) {
        const s = this.bookStatus(book);
        if (sameStatus(s, this.statusSent.get(book))) continue;
        this.statusSent.set(book, s);
        status.push(s);
      }

      this.pending.quotes.clear();
      this.pending.removedQuotes.clear();
      this.pending.games.clear();
      this.pending.markets.clear();
      this.pending.status.clear();

      if (games.length) delta.games = games;
      if (removedGames.length) delta.removedGames = removedGames;
      if (quotes.length) delta.quotes = quotes;
      if (removedQuotes.length) delta.removedQuotes = removedQuotes;
      if (bests.length) delta.bests = bests;
      if (status.length) delta.status = status;
      if (!games.length && !removedGames.length && !quotes.length && !removedQuotes.length && !bests.length && !status.length) return;

      delta.seq = ++this.seqNo;
      this.ring.push(delta);
      if (this.ring.length > (this.opts.ringSize ?? 2_000)) this.ring.shift();
      for (const q of quotes) if (q.ch !== 'snapshot') this.opts.latency?.record('serverProcessing', { book: q.book, phase: q.live ? 'live' : 'pre', channel: q.ch, feed: q.feed }, now - q.rx);
      this.emit('delta', delta);
    } catch (err) {
      this.counters.aggregatorErrors++;
      this.log(`board flush error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    }
  }

  private spec(book: BookId): BookSpec {
    return this.books.find((b) => b.id === book)!;
  }

  /** One book's view of a game: from healthy feeds; from any feed only when none is healthy. */
  private bookGame(book: BookId, gk: string): BookGame | null {
    const feeds = this.feedsOf(book);
    const pool = this.anyHealthy(book) ? feeds.filter(this.healthy) : feeds;
    const views = pool.map((f) => f.games.get(gk)).filter((g): g is BookGame => !!g);
    if (!views.length) return null;
    return { ...views[0]!, live: views.some((g) => g.live) };
  }

  private wireGame(gk: string): WireGame | null {
    const views = this.books.map((b) => this.bookGame(b.id, gk)).filter((g): g is BookGame => !!g);
    if (!views.length) return null;
    const g = views[0]!;
    return {
      key: gk,
      away: g.away,
      home: g.home,
      awayName: TEAM_NAMES.get(g.away) ?? g.away,
      homeName: TEAM_NAMES.get(g.home) ?? g.home,
      start: views.map((v) => v.startTime).sort()[0]!,
      live: views.some((v) => v.live),
      books: views.map((v) => v.book),
      ...(this.suspect.has(gk) ? { suspect: true } : {}),
    };
  }

  private eligible(book: BookId, v: MergedValue, game: WireGame, ignoreSuspect = false): boolean {
    return !v.suspended && this.anyHealthy(book) && isValidAmerican(v.american) && !(game.live && !v.live) && (ignoreSuspect || !game.suspect);
  }

  private offers(gk: string, game: WireGame, ignoreSuspect = false): GameOffers {
    const offers: GameOffers = { live: game.live, books: {} };
    for (const spec of this.books) {
      for (const market of MARKETS) {
        for (const side of MARKET_SIDES[market]) {
          const v = this.merges.get(quoteKey(spec.id, gk, market, side))?.value;
          if (!v || !this.eligible(spec.id, v, game, ignoreSuspect)) continue;
          const byMarket = (offers.books[spec.id] ??= {});
          (byMarket[market] ??= {})[side] = { book: spec.id, side, line: v.line, american: v.american };
        }
      }
    }
    return offers;
  }

  private computeBests(gk: string, market: MarketType, why: 'price' | 'eligibility'): WireBest[] {
    const game = this.gamesSent.get(gk)!;
    const offers = this.offers(gk, game);
    return MARKET_SIDES[market].map((side): WireBest => {
      const r = bestOf(offers, market, side, this.opts.best);
      if (!r) return { game: gk, market, side, none: true, cause: why };
      const w = r.offers[0]!;
      return { game: gk, market, side, books: r.books, line: w.line, american: w.american, exact: r.exact, rule: r.rule, reason: r.reason, cause: why };
    });
  }

  /** Two eligible books whose no-vig probabilities for the same side differ by > 20 points at near-identical lines. */
  private looksSuspect(gk: string): boolean {
    const game = this.gamesSent.get(gk)!;
    const offers = this.offers(gk, game, true);
    for (const market of ['moneyline', 'spread'] as const) {
      const probs: { p: number; line: number | null }[] = [];
      for (const spec of this.books) {
        const m = offers.books[spec.id]?.[market];
        if (!m?.home || !m.away) continue;
        const ih = 1 / americanToDecimal(m.home.american);
        const ia = 1 / americanToDecimal(m.away.american);
        probs.push({ p: ih / (ih + ia), line: m.home.line });
      }
      for (let i = 0; i < probs.length; i++) {
        for (let j = i + 1; j < probs.length; j++) {
          const a = probs[i]!;
          const b = probs[j]!;
          const lineGap = a.line === null || b.line === null ? 0 : Math.abs(a.line - b.line);
          if (lineGap <= SANITY_MAX_LINE_DIFF && Math.abs(a.p - b.p) > SANITY_MAX_GAP) return true;
        }
      }
    }
    return false;
  }

  bookStatus(book: BookId): WireBookStatus {
    const fs = this.feedsOf(book).sort((a, b) => Number(this.healthy(b)) - Number(this.healthy(a)) || STATE_RANK[a.status.state] - STATE_RANK[b.status.state]);
    const best = fs[0];
    const stale = !fs.some(this.healthy);
    const lastData = fs.map((f) => f.status.lastDataAt).filter((t): t is number => t !== null);
    const detail = stale && fs.length ? fs.map((f) => `${f.box}: ${this.feedDetail(f)}`).join('; ') : (best?.status.detail ?? null);
    return {
      book,
      state: best?.status.state ?? 'stopped',
      stale,
      detail,
      lastDataAt: lastData.length ? Math.max(...lastData) : null,
      lastChangeAt: this.lastChangeAt.get(book) ?? null,
      feeds: fs.map((f) => ({ id: f.box, state: f.status.state, stale: !this.healthy(f), detail: f.frozen || !f.linked ? this.feedDetail(f) : f.status.detail, lastDataAt: f.status.lastDataAt })),
    };
  }

  private feedDetail(f: FeedState): string {
    if (!f.linked) return 'feed link down';
    if (f.frozen) return 'suspected frozen: no price changes while the other feed moves';
    if (f.status.detail) return f.status.detail;
    // Stable text: the UI renders "no data for Xs" from lastDataAt, so this doesn't change every second.
    return f.stale && f.status.lastDataAt !== null ? `${f.status.state}, data overdue` : f.status.state;
  }

  status(): WireBookStatus[] {
    return this.books.map((b) => this.bookStatus(b.id));
  }

  /** Full state as of the current `seq` (what a client has after applying every delta). */
  snapshot(): Snapshot {
    return {
      boot: this.boot,
      seq: this.seqNo,
      ts: this.now(),
      books: this.books.map(({ id, name, short, color, region }) => ({ id, name, short, color, ...(region ? { region } : {}) })),
      status: this.status(),
      games: [...this.gamesSent.values()],
      quotes: [...this.quotesSent.values()],
      bests: [...this.bestsSent.values()],
    };
  }

  /** The snapshot serialized once per `seq`: a reconnect storm costs one serialization, not N. */
  snapshotJson(): { seq: number; json: string } {
    if (this.snapshotCache?.seq !== this.seqNo) this.snapshotCache = { seq: this.seqNo, json: JSON.stringify(this.snapshot()) };
    return this.snapshotCache;
  }

  /** Deltas after `seq`, or null when they are no longer (or not yet) in the ring. */
  since(seq: number): Delta[] | null {
    if (seq === this.seqNo) return [];
    if (seq > this.seqNo) return null;
    const first = this.ring[0]?.seq;
    if (first === undefined || seq < first - 1) return null;
    return this.ring.filter((d) => d.seq > seq);
  }

  health() {
    return {
      boot: this.boot,
      seq: this.seqNo,
      counters: this.counters,
      books: this.status(),
      feeds: [...this.feeds.values()].map((f) => ({
        feed: f.box,
        book: f.book,
        healthy: this.healthy(f),
        state: f.status.state,
        detail: this.feedDetail(f),
        linked: f.linked,
        frozen: f.frozen,
        quotes: f.keys.size,
        games: f.games.size,
        lastDataAt: f.status.lastDataAt,
        heldRemovals: f.held?.refs.length ?? 0,
      })),
      games: this.gamesSent.size,
      quotes: this.quotesSent.size,
      suspectGames: [...this.suspect],
      singleBookGames: [...this.gamesSent.values()].filter((g) => g.books.length < this.books.length).map((g) => g.key),
    };
  }
}

function sameBest(a: WireBest, b: WireBest): boolean {
  if (a.none || b.none) return !!a.none === !!b.none;
  return a.line === b.line && a.american === b.american && a.exact === b.exact && a.rule === b.rule && a.reason === b.reason && a.books.join() === b.books.join();
}

/** Status changes worth a delta. `lastDataAt`/`lastChangeAt` move constantly and ride on heartbeats. */
function sameStatus(a: WireBookStatus, b: WireBookStatus | undefined): boolean {
  if (!b) return false;
  const feeds = (s: WireBookStatus) => s.feeds.map((f) => `${f.id}:${f.state}:${f.stale}:${f.detail}`).join('|');
  return a.state === b.state && a.stale === b.stale && a.detail === b.detail && feeds(a) === feeds(b);
}
