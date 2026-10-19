import { describe, expect, it } from 'vitest';
import type { Channel } from '../src/shared/domain.js';
import { QuoteMerge, stateSig, type FeedReport, type QuoteState } from '../src/server/feedMerge.js';

const st = (american: number, line: number | null = -3.5, suspended = false): QuoteState => ({ american, line, suspended, live: false });
const rep = (feed: string, state: QuoteState, receivedAt: number, bookTime: number | null = null, channel: Channel = bookTime === null ? 'poll' : 'push'): FeedReport => ({
  feed,
  state,
  bookTime,
  receivedAt,
  channel,
});
const allHealthy = () => true;

describe('QuoteMerge rules', () => {
  it('accepts the first copy and counts the second copy as a duplicate with its lag', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 0 });
    expect(m.report(rep('A', st(-110), 1_000, 900), 1_000).kind).toBe('accepted');
    expect(m.report(rep('B', st(-110), 1_250, 900), 1_250)).toEqual({ kind: 'duplicate', lagMs: 250 });
    expect(m.report(rep('B', st(-110), 1_300, 900), 1_300)).toEqual({ kind: 'duplicate', lagMs: null }); // counted once
  });

  it('rejects a report whose book timestamp predates the shown state', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 0 });
    m.report(rep('A', st(-115), 2_000, 1_900), 2_000);
    expect(m.report(rep('B', st(-110), 2_100, 1_500), 2_100)).toEqual({ kind: 'rejected', reason: 'older' });
    expect(m.value!.american).toBe(-115);
  });

  it('rejects a lagging push channel re-reporting states the board already moved past', () => {
    // FD-style whole-second timestamps: all three changes land in the same second.
    const m = new QuoteMerge({ bookTimeResolutionMs: 1_000 });
    m.report(rep('A:snapshot', st(-120), 0, null, 'snapshot'), 0);
    m.report(rep('B:snapshot', st(-120), 0, null, 'snapshot'), 0);
    expect(m.report(rep('A:push', st(-110), 1_500, 1_000), 1_500).kind).toBe('accepted');
    expect(m.report(rep('A:push', st(-115), 1_600, 1_000), 1_600).kind).toBe('accepted');
    // B's push channel is behind: its first change is -110, already shown and superseded.
    expect(m.report(rep('B:push', st(-110), 1_900, 1_000), 1_900)).toEqual({ kind: 'rejected', reason: 'late-copy' });
    expect(m.report(rep('B:push', st(-115), 2_000, 1_000), 2_000).kind).toBe('duplicate');
    expect(m.value!.american).toBe(-115);
  });

  it('keeps rejecting a late copy that its feed delivers twice (as a sample, then as a change)', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 1_000 });
    m.report(rep('A:snapshot', st(-120), 0, null, 'snapshot'), 0);
    m.report(rep('B:snapshot', st(-120), 0, null, 'snapshot'), 0);
    expect(m.report(rep('A:push', st(-111), 12_252, 12_000), 12_252).kind).toBe('accepted');
    expect(m.report(rep('A:push', st(-116), 12_501, 12_000), 12_501).kind).toBe('accepted');
    // Box B's copy of -111 lands after A showed -116, from the same second: a late copy both times.
    const late = rep('B:push', st(-111), 12_250, 12_000);
    expect(m.report(late, 14_252)).toEqual({ kind: 'rejected', reason: 'late-copy' });
    expect(m.report(late, 14_252).kind).not.toBe('accepted');
    expect(m.value!.american).toBe(-116);
  });

  it('treats a later poll of an earlier value as a genuine reversal (polls observe the present)', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 1_000 });
    m.report(rep('A:poll', st(-110), 1_000), 1_000);
    m.report(rep('A:poll', st(-115), 2_000), 2_000);
    expect(m.report(rep('B:poll', st(-110), 2_500), 2_500).kind).toBe('accepted');
    // ...but a poll answered before the shown state was observed is older.
    expect(m.report(rep('B:poll', st(-120), 1_900), 1_900)).toEqual({ kind: 'rejected', reason: 'older' });
  });

  it('shows a genuine revert from the leading feed immediately', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 1_000 });
    m.report(rep('A', st(-110), 1_000), 1_000);
    m.report(rep('A', st(-115), 2_000), 2_000);
    const r = m.report(rep('A', st(-110), 3_000), 3_000);
    expect(r.kind).toBe('accepted');
    expect(m.value!.american).toBe(-110);
  });

  it('heals a revert first seen by a lagging feed once every healthy feed agrees for 3 s', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 1_000 });
    m.report(rep('A', st(-110), 1_000), 1_000);
    m.report(rep('B', st(-110), 1_100), 1_100);
    m.report(rep('A', st(-115), 2_000), 2_000);
    // B never saw -115; it reports a revert to -110 that rule 3 can't tell from a late copy.
    m.report(rep('B', st(-115), 2_050), 2_050);
    m.report(rep('B', st(-110), 3_000), 3_000);
    m.report(rep('A', st(-110), 3_200), 3_200);
    expect(m.value!.american).toBe(-110); // A's own revert is accepted at once
  });

  it('fails over to the healthy feed when the shown value’s feed goes unhealthy', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 0 });
    m.report(rep('A', st(-110), 1_000, 1_000), 1_000);
    m.report(rep('B', st(-110), 1_100, 1_000), 1_100);
    m.report(rep('B', st(-120), 5_000, 4_900), 5_000); // B moves on; accepted as new
    expect(m.value!.american).toBe(-120);
    const healthy = (f: string) => f !== 'B';
    m.report(rep('A', st(-110), 5_100, 1_000), 5_100); // A is frozen on the old value
    expect(m.sweep(healthy, 5_200).kind).toBe('accepted'); // B unhealthy → fall back to A's view
    expect(m.value!.feed).toBe('A');
  });

  it('removes a quote only once no healthy feed lists it', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 0 });
    m.report(rep('A', st(-110), 1_000, 1_000), 1_000);
    m.report(rep('B', st(-110), 1_100, 1_000), 1_100);
    expect(m.remove('A', allHealthy, 2_000).kind).toBe('none');
    expect(m.value!.feed).toBe('B');
    expect(m.remove('B', allHealthy, 2_100).kind).toBe('removed');
    expect(m.value).toBeNull();
  });

  it('keeps the last value when every feed is unhealthy (the book shows as stale instead)', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 0 });
    m.report(rep('A', st(-110), 1_000, 1_000), 1_000);
    expect(m.sweep(() => false, 9_000, false).kind).toBe('none');
    expect(m.value!.american).toBe(-110);
  });

  it('sets prev only when the price or line moves', () => {
    const m = new QuoteMerge({ bookTimeResolutionMs: 0 });
    m.report(rep('A', st(-110), 1_000, 1_000), 1_000);
    m.report(rep('A', st(-110, -3.5, true), 2_000, 2_000), 2_000); // suspended only
    expect(m.value!.prev).toBeUndefined();
    m.report(rep('A', st(-120, -3.5, true), 3_000, 3_000), 3_000);
    expect(m.value!.prev).toEqual({ american: -110, line: -3.5, at: 3_000 });
  });
});

// ------------------------------------------------------------------------------------- simulation

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimOptions {
  seed: number;
  changes: number;
  bookTimeResolutionMs: number;
  pushDrop: number;
}

/**
 * One quote's true price path, observed by two boxes. Each box has a push channel (every change in
 * order, 300-900 ms behind, some frames dropped) and a 1 s poll (phase 0 / 500 ms). Each channel is
 * its own feed, as the board consumes the connectors' per-channel `sample` events: a channel reports
 * only when its own view changes, and never goes backwards.
 */
function simulate(o: SimOptions) {
  const rnd = mulberry32(o.seed);
  // True path: prices drift, sometimes revert to the previous price, sometimes move in bursts.
  const path: { t: number; state: QuoteState }[] = [{ t: 0, state: st(-110) }];
  let t = 0;
  for (let i = 1; i <= o.changes; i++) {
    t += rnd() < 0.3 ? 50 + rnd() * 250 : 400 + rnd() * 6_000;
    const prev = path[i - 1]!.state.american;
    const revert = i >= 2 && rnd() < 0.2;
    let american = revert ? path[i - 2]!.state.american : prev + (rnd() < 0.5 ? -5 : 5) * (1 + Math.floor(rnd() * 3));
    if (american > -100 && american < 100) american = american < 0 ? 100 : -105;
    if (american === prev) american = prev - 5;
    path.push({ t, state: st(american) });
  }
  const end = t + 10_000;
  const bt = (ti: number) => (o.bookTimeResolutionMs ? Math.floor(ti / o.bookTimeResolutionMs) * o.bookTimeResolutionMs : ti);
  const indexAt = (time: number) => {
    let idx = 0;
    while (idx + 1 < path.length && path[idx + 1]!.t <= time) idx++;
    return idx;
  };

  type Arrival = { at: number; feed: string; idx: number; report: FeedReport };
  const arrivals: Arrival[] = [];
  for (const [box, phase] of [['A', 0], ['B', 500]] as const) {
    // Push channel: in order, with drops; reports every change it delivers.
    let lastPush = 0;
    for (let i = 1; i < path.length; i++) {
      if (rnd() < o.pushDrop) continue;
      lastPush = Math.max(lastPush, path[i]!.t + 300 + rnd() * 600);
      const feed = `${box}:push`;
      arrivals.push({ at: lastPush, feed, idx: i, report: rep(feed, path[i]!.state, lastPush, bt(path[i]!.t), 'push') });
    }
    // Poll channel: reports only when what it sees differs from its previous observation.
    let seen = 0;
    for (let pt = phase; pt < end; pt += 1_000) {
      const rtt = 12 + rnd() * 48;
      const idx = indexAt(pt + rtt / 2);
      if (stateSig(path[idx]!.state) === stateSig(path[seen]!.state) && idx >= seen) {
        seen = idx;
        continue;
      }
      seen = idx;
      const feed = `${box}:poll`;
      arrivals.push({ at: pt + rtt, feed, idx, report: rep(feed, path[idx]!.state, pt + rtt, null, 'poll') });
    }
  }
  arrivals.sort((a, b) => a.at - b.at);

  const m = new QuoteMerge({ bookTimeResolutionMs: o.bookTimeResolutionMs });
  m.report(rep('A:snapshot', path[0]!.state, 0, 0, 'snapshot'), 0);
  m.report(rep('B:snapshot', path[0]!.state, 0, 0, 'snapshot'), 0);
  const shown: { at: number; key: string }[] = [{ at: 0, key: 'A:snapshot@0' }];
  const delivered = new Set<number>([0]);
  let nextSweep = 1_000;
  for (const a of arrivals) {
    while (nextSweep <= a.at) {
      const r = m.sweep(allHealthy, nextSweep);
      if (r.kind === 'accepted') shown.push({ at: nextSweep, key: `${r.value.feed}@${r.value.receivedAt}` });
      nextSweep += 1_000;
    }
    delivered.add(a.idx);
    const r = m.report(a.report, a.at);
    if (r.kind === 'accepted') shown.push({ at: a.at, key: `${r.value.feed}@${r.value.receivedAt}` });
  }
  for (; nextSweep <= end + 5_000; nextSweep += 1_000) {
    const r = m.sweep(allHealthy, nextSweep);
    if (r.kind === 'accepted') shown.push({ at: nextSweep, key: `${r.value.feed}@${r.value.receivedAt}` });
  }

  // Map each shown value back to the exact arrival it came from (feed + receive time is unique).
  const firstArrival = new Map<number, number>();
  for (const a of arrivals) if (!firstArrival.has(a.idx)) firstArrival.set(a.idx, a.at);
  const idxOf = new Map(arrivals.map((a) => [`${a.feed}@${a.at}`, a.idx]));
  idxOf.set('A:snapshot@0', 0).set('B:snapshot@0', 0);
  const shownIdx = shown.map((s) => idxOf.get(s.key)!);
  let rollbacks = 0;
  for (let i = 1; i < shownIdx.length; i++) if (shownIdx[i]! < shownIdx[i - 1]!) rollbacks++;
  const delays = shown
    .map((s, i) => (i > 0 && shownIdx[i]! > 0 ? s.at - firstArrival.get(shownIdx[i]!)! : 0))
    .filter((d) => d > 1);
  return { final: m.value ? stateSig(m.value) : null, truth: stateSig(path.at(-1)!.state), rollbacks, lateFirstCopies: delays.length, delays, shown: shown.length, changes: o.changes };
}

describe('QuoteMerge simulation: two feeds over one true price path', () => {
  for (const [label, res] of [
    ['DK-style exact book times', 0],
    ['FD-style whole-second book times', 1_000],
  ] as const) {
    it(`${label}: converges, never rolls back, and shows each new state at its first arrival`, () => {
      let rollbacks = 0;
      let shown = 0;
      const delays: number[] = [];
      for (let seed = 1; seed <= 200; seed++) {
        const r = simulate({ seed, changes: 60, bookTimeResolutionMs: res, pushDrop: 0.05 });
        expect(r.final, `seed ${seed}`).toBe(r.truth);
        rollbacks += r.rollbacks;
        delays.push(...r.delays);
        shown += r.shown;
      }
      expect(rollbacks).toBe(0);
      // Never rolling back has a price: an FD push whose whole-second timestamp straddles a poll
      // observation is held back until the next poll (0.5 s cadence across two boxes) proves it.
      // Keep that rare and short.
      delays.sort((a, b) => a - b);
      const p90 = delays[Math.floor(delays.length * 0.9)] ?? 0;
      expect(delays.length / shown).toBeLessThan(0.05);
      expect(p90).toBeLessThan(750);
    });
  }
});
