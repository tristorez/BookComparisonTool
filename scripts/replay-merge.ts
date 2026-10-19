/**
 * Replays a recorded live FanDuel session (PIR push frames + 1 s SMP polls) through both merge layers
 * and reports, per strategy: price changes shown, states shown before push delivered them, wrong-way
 * flips, and how late any state appeared after its first arrival.
 *
 *   npx tsx scripts/replay-merge.ts [test/fixtures/fd-live-2026-10-19.jsonl.gz]
 *
 * Ground truth is push's own ordered sequence (complete and in order, but late). A shown state's
 * position is the push frame carrying it; for a poll that is ahead, the push frame that confirms it
 * within 5 s. A flip is a shown change that moves backwards in that sequence. Polls in the recording's
 * last 5 s can't be matched to a later push frame, so they are left unclassified.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { MarketMerge, signatureOf } from '../src/books/fanduel.js';
import { QuoteMerge, stateSig, type FeedReport, type QuoteState } from '../src/server/feedMerge.js';

const DEFAULT_FIXTURE = fileURLToPath(new URL('../test/fixtures/fd-live-2026-10-19.jsonl.gz', import.meta.url));
/** A poll counts as ahead of push if push delivers the same state within this window. */
const AHEAD_WINDOW_MS = 5_000;

type Channel = 'snapshot' | 'push' | 'poll';

interface FdMarketState {
  marketId: string;
  marketStatus?: string;
  inplay?: boolean;
  updatedAt?: string;
  runnerDetails?: { selectionId: number; handicap: number | null; runnerStatus?: string; winRunnerOdds?: { americanDisplayOdds?: { americanOddsInt?: number } } }[];
}

type FixtureLine =
  | { kind: 'meta'; source: string }
  | { kind: 'push'; t: number; market: FdMarketState }
  | { kind: 'poll'; t: number; sentAt: number; markets: FdMarketState[] };

/** One channel's view of one market (or quote) changing; channels report only their own changes, like `sample` events. */
interface Observation {
  channel: Channel;
  t: number;
  key: string;
  sig: string;
  bookTime: number | null;
  state?: QuoteState;
}

interface Strategy {
  /** True if this observation is shown now. */
  offer(o: Observation): boolean;
  /** A state shown by a periodic repair, if any. */
  sweep?(now: number): string | null;
}

export interface ReplayResult {
  level: 'market' | 'quote';
  strategy: string;
  shown: number;
  flips: number;
  early: number;
  pushStates: number;
  meanEarlyMs: number;
  late: number;
  lateP50: number;
  lateP90: number;
  lateMax: number;
}

export interface Replay {
  source: string;
  pushFrames: number;
  polls: number;
  results: ReplayResult[];
}

export function replay(path = DEFAULT_FIXTURE): Replay {
  const buf = readFileSync(path);
  const text = path.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as FixtureLine);
  const meta = lines.find((l): l is Extract<FixtureLine, { kind: 'meta' }> => l.kind === 'meta');

  const marketObs: Observation[] = [];
  const quoteObs: Observation[] = [];
  let firstPoll = true;
  const add = (channel: Channel, t: number, m: FdMarketState) => {
    const inPlay = Boolean(m.inplay);
    const bookTime = channel === 'push' && m.updatedAt ? Date.parse(m.updatedAt) : null;
    const asUpdate = { ...m, runnerDetails: m.runnerDetails?.map((r) => ({ ...r, handicap: r.handicap ?? undefined })) };
    marketObs.push({ channel, t, key: m.marketId, sig: signatureOf(asUpdate, inPlay), bookTime });
    for (const r of m.runnerDetails ?? []) {
      const american = r.winRunnerOdds?.americanDisplayOdds?.americanOddsInt;
      if (american === undefined) continue;
      const state: QuoteState = { american, line: r.handicap, suspended: m.marketStatus !== 'OPEN' || r.runnerStatus !== 'ACTIVE', live: inPlay };
      quoteObs.push({ channel, t, key: `${m.marketId}:${r.selectionId}`, sig: stateSig(state), bookTime, state });
    }
  };
  for (const l of lines) {
    if (l.kind === 'push') add('push', l.t, l.market);
    if (l.kind === 'poll') {
      for (const m of l.markets) add(firstPoll ? 'snapshot' : 'poll', l.t, m);
      firstPoll = false;
    }
  }
  const endAt = Math.max(...lines.filter((l) => l.kind !== 'meta').map((l) => (l as { t: number }).t));
  const market = dedupe(marketObs);
  const quote = dedupe(quoteObs);

  const changesOnly = (): Strategy => {
    let shown = '';
    return { offer: (o) => (o.sig === shown ? false : ((shown = o.sig), true)) };
  };
  const results = [
    evaluate('market', 'push only', market, endAt, () => {
      let shown = '';
      return { offer: (o) => (o.channel !== 'push' || o.sig === shown ? false : ((shown = o.sig), true)) };
    }),
    evaluate('market', 'any change', market, endAt, changesOnly),
    evaluate('market', 'MarketMerge (connector)', market, endAt, () => {
      const mm = new MarketMerge();
      return { offer: (o) => mm.offer(o.channel, o.sig, o.t, o.bookTime, true) };
    }),
    evaluate('quote', 'any change', quote, endAt, changesOnly),
    evaluate('quote', 'QuoteMerge (board)', quote, endAt, () => {
      const qm = new QuoteMerge({ bookTimeResolutionMs: 1000 });
      return {
        offer: (o) => {
          const r: FeedReport = { feed: `A:${o.channel}`, state: o.state!, bookTime: o.bookTime, receivedAt: o.t, channel: o.channel };
          return qm.report(r, o.t).kind === 'accepted';
        },
        sweep: (now) => {
          const res = qm.sweep(() => true, now);
          return res.kind === 'accepted' ? stateSig(res.value) : null;
        },
      };
    }),
  ];
  return {
    source: meta?.source ?? path,
    pushFrames: lines.filter((l) => l.kind === 'push').length,
    polls: lines.filter((l) => l.kind === 'poll').length,
    results,
  };
}

/** Sort by arrival and keep only observations where that channel's own view changed (SMP's first read and its polls are one channel). */
function dedupe(obs: Observation[]): Observation[] {
  const last = new Map<string, string>();
  return [...obs]
    .sort((a, b) => a.t - b.t)
    .filter((o) => {
      const k = `${o.channel === 'push' ? 'push' : 'smp'}|${o.key}`;
      if (last.get(k) === o.sig) return false;
      last.set(k, o.sig);
      return true;
    });
}

function evaluate(level: ReplayResult['level'], strategy: string, obs: Observation[], endAt: number, make: () => Strategy): ReplayResult {
  const pushSeq = new Map<string, { t: number; sig: string }[]>();
  for (const o of obs) if (o.channel === 'push') (pushSeq.get(o.key) ?? pushSeq.set(o.key, []).get(o.key)!).push({ t: o.t, sig: o.sig });

  const position = (key: string, sig: string, t: number, channel: Channel): number | null => {
    const seq = pushSeq.get(key);
    if (!seq) return null;
    if (channel === 'push') return seq.findIndex((x) => x.t === t && x.sig === sig);
    const ahead = seq.findIndex((x) => x.t >= t && x.sig === sig && x.t - t <= AHEAD_WINDOW_MS);
    if (ahead >= 0) return ahead;
    if (t > endAt - AHEAD_WINDOW_MS) return null; // the confirming push may fall after the recording ends
    for (let i = seq.length - 1; i >= 0; i--) if (seq[i]!.t < t && seq[i]!.sig === sig) return i; // a stale read
    return null;
  };

  const strategies = new Map<string, Strategy>();
  const shown = new Map<string, string>();
  const highest = new Map<string, number>();
  const firstShownAt = new Map<string, number>(); // key#position -> first time shown
  const firstSeen = new Map<string, Map<string, number>>(); // key -> sig -> earliest report since the display last changed
  const lateness: number[] = [];
  let shownCount = 0;
  let flips = 0;

  const onShow = (key: string, sig: string, t: number, channel: Channel) => {
    if (shown.get(key) === sig) return;
    shownCount++;
    const p = position(key, sig, t, channel);
    if (p !== null) {
      const cur = highest.get(key);
      if (cur !== undefined && p < cur) flips++;
      highest.set(key, cur === undefined ? p : Math.max(cur, p));
      if (!firstShownAt.has(`${key}#${p}`)) firstShownAt.set(`${key}#${p}`, t);
    }
    const seen = firstSeen.get(key)?.get(sig);
    if (seen !== undefined && seen < t) lateness.push(t - seen);
    shown.set(key, sig);
    firstSeen.set(key, new Map());
  };

  let nextSweep = (obs[0]?.t ?? 0) + 1_000;
  for (const o of obs) {
    for (; o.t >= nextSweep; nextSweep += 1_000) {
      for (const [key, s] of strategies) {
        const sig = s.sweep?.(nextSweep);
        if (sig) onShow(key, sig, nextSweep, 'poll');
      }
    }
    const s = strategies.get(o.key) ?? strategies.set(o.key, make()).get(o.key)!;
    const seen = firstSeen.get(o.key) ?? firstSeen.set(o.key, new Map()).get(o.key)!;
    if (o.sig !== shown.get(o.key) && !seen.has(o.sig)) seen.set(o.sig, o.t);
    if (s.offer(o)) onShow(o.key, o.sig, o.t, o.channel);
  }

  const leads: number[] = [];
  for (const [k, t] of firstShownAt) {
    const hash = k.lastIndexOf('#');
    leads.push(pushSeq.get(k.slice(0, hash))![Number(k.slice(hash + 1))]!.t - t);
  }
  const early = leads.filter((x) => x > 0);
  const sorted = [...lateness].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
  return {
    level,
    strategy,
    shown: shownCount,
    flips,
    early: early.length,
    pushStates: leads.length,
    meanEarlyMs: early.length ? Math.round(early.reduce((a, b) => a + b, 0) / early.length) : 0,
    late: lateness.length,
    lateP50: q(0.5),
    lateP90: q(0.9),
    lateMax: sorted.at(-1) ?? 0,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = replay(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(`${r.source}\n${r.pushFrames} push frames, ${r.polls} polls\n`);
  console.log(`${'level'.padEnd(7)}${'strategy'.padEnd(26)}${'shown'.padStart(6)}${'flips'.padStart(7)}   ${'early vs push'.padEnd(26)}late`);
  for (const x of r.results) {
    const early = `${x.early}/${x.pushStates}${x.early ? ` (mean ${x.meanEarlyMs} ms)` : ''}`;
    const late = x.late ? `${x.late} (p50 ${x.lateP50} / p90 ${x.lateP90} / max ${x.lateMax} ms)` : '0';
    console.log(`${x.level.padEnd(7)}${x.strategy.padEnd(26)}${String(x.shown).padStart(6)}${String(x.flips).padStart(7)}   ${early.padEnd(26)}${late}`);
  }
}
