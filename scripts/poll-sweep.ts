/**
 * What does the FanDuel poll interval cost in latency? Replays the recorded live session (PIR push frames
 * + 1 s SMP polls) with the polls thinned to every Nth one, so the same real price moves are seen through
 * 1 s, 2 s, 5 s ... polling, with and without push.
 *
 *   npx tsx scripts/poll-sweep.ts [test/fixtures/fd-live-2026-10-19.jsonl.gz]
 *
 * Reference ("best") = the earliest any channel in the full recording (push + every 1 s poll) showed each
 * price state of a market. A config's delay for a state = when it first showed that state minus the reference
 * time. A state the config never shows on its own is "missed" (a transient the slower channel skipped over).
 * Thinning keeps every Nth poll, so each interval is run at every phase (N offsets) and pooled.
 * 0.5 s polling can't be replayed: the recording has no polls between the 1 s ones.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { signatureOf } from '../src/books/fanduel.js';

const DEFAULT_FIXTURE = fileURLToPath(new URL('../test/fixtures/fd-live-2026-10-19.jsonl.gz', import.meta.url));

/** A state shown later than this after the reference counts as missed (it is a recurrence, not the same move). */
const WINDOW_MS = 5_000;

interface Mkt { marketId: string; inplay?: boolean; runnerDetails?: { handicap: number | null }[] }
type Line =
  | { kind: 'meta' }
  | { kind: 'push'; t: number; market: Mkt }
  | { kind: 'poll'; t: number; markets: Mkt[] };
interface Obs { push: boolean; t: number; key: string; sig: string }
interface Ev { sig: string; t: number }

const path = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_FIXTURE;
const buf = readFileSync(path);
const lines = (path.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);

const sigOf = (m: Mkt) => signatureOf({ ...m, runnerDetails: m.runnerDetails?.map((r) => ({ ...r, handicap: r.handicap ?? undefined })) } as never, Boolean(m.inplay));
const pushObs: Obs[] = [];
const polls: Obs[][] = [];
for (const l of lines) {
  if (l.kind === 'push') pushObs.push({ push: true, t: l.t, key: l.market.marketId, sig: sigOf(l.market) });
  if (l.kind === 'poll') polls.push(l.markets.map((m) => ({ push: false, t: l.t, key: m.marketId, sig: sigOf(m) })));
}
const startAt = polls[0]![0]!.t; // the first poll is the snapshot every config starts from
const endAt = lines.reduce((m, l) => ('t' in l ? Math.max(m, l.t) : m), 0);

/** Per market, the sequence of shown changes when every observation is shown the moment it arrives. */
function timeline(obs: Obs[]): Map<string, Ev[]> {
  const out = new Map<string, Ev[]>();
  const shown = new Map<string, string>();
  for (const o of [...obs].sort((a, b) => a.t - b.t)) {
    if (shown.get(o.key) === o.sig) continue;
    shown.set(o.key, o.sig);
    (out.get(o.key) ?? out.set(o.key, []).get(o.key)!).push({ sig: o.sig, t: o.t });
  }
  return out;
}

const build = (usePush: boolean, every: number, phase: number): Obs[] => {
  const o: Obs[] = [];
  polls.forEach((p, i) => { if (every > 0 && (i === 0 || (i - 1) % every === phase % every)) o.push(...p); });
  if (usePush) o.push(...pushObs.filter((x) => x.t >= startAt));
  return o;
};

const best = timeline(build(true, 1, 0));
const ref = [...best.values()].flat().length;

function delays(cfg: Map<string, Ev[]>): { d: number[]; missed: number } {
  const d: number[] = [];
  let missed = 0;
  for (const [key, bevs] of best) {
    const evs = cfg.get(key) ?? [];
    let j = 0;
    for (const b of bevs) {
      let k = j;
      while (k < evs.length && !(evs[k]!.sig === b.sig && evs[k]!.t >= b.t - 1) && evs[k]!.t <= b.t + WINDOW_MS) k++;
      if (k < evs.length && evs[k]!.sig === b.sig && evs[k]!.t <= b.t + WINDOW_MS) { d.push(Math.max(0, evs[k]!.t - b.t)); j = k + 1; } else missed++;
    }
  }
  return { d, missed };
}

const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? 0;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const max = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), 0);

const configs: { name: string; push: boolean; every: number }[] = [
  { name: 'push only', push: true, every: 0 },
  { name: 'poll only 1 s', push: false, every: 1 },
  { name: 'poll only 2 s', push: false, every: 2 },
  { name: 'poll only 5 s  (FD site)', push: false, every: 5 },
  { name: 'push + poll 1 s (shipped)', push: true, every: 1 },
  { name: 'push + poll 2 s', push: true, every: 2 },
  { name: 'push + poll 5 s', push: true, every: 5 },
];

console.log(`${path.split('/').pop()}: ${pushObs.length} push frames, ${polls.length} polls, ${((endAt - startAt) / 1000).toFixed(0)} s, ${ref} price states (reference = earliest of push + 1 s polls)\n`);
console.log(`${'config'.padEnd(28)}${'mean'.padStart(8)}${'p50'.padStart(7)}${'p90'.padStart(7)}${'p99'.padStart(7)}${'max'.padStart(7)}${'missed'.padStart(9)}   (delay vs reference, ms)`);
for (const c of configs) {
  const pooled: number[] = [];
  let missed = 0;
  const phases = c.every > 1 ? c.every : 1;
  for (let ph = 0; ph < phases; ph++) {
    const r = delays(timeline(build(c.push, c.every, ph)));
    pooled.push(...r.d);
    missed += r.missed;
  }
  const m = ((missed / phases / ref) * 100).toFixed(1);
  console.log(`${c.name.padEnd(28)}${mean(pooled).toFixed(0).padStart(8)}${String(q(pooled, 0.5)).padStart(7)}${String(q(pooled, 0.9)).padStart(7)}${String(q(pooled, 0.99)).padStart(7)}${String(max(pooled)).padStart(7)}${(m + '%').padStart(9)}`);
}
