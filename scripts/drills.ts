/**
 * Resilience drills (Decisions.txt D-25, D-26, D-35), end to end with synthetic books: a board process
 * (feed A) and a feed process (feed B) on this machine, linked over TCP as Box A and Box B are. Each
 * drill breaks one thing and times how the board's public state (/api/health, /api/board, the stream)
 * reacts. Fake books are one book across processes (src/server/fake.ts), so feed B sees what feed A sees.
 *
 *   npm run drills            # ~5 minutes; prints a Markdown table
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { connect, createServer, type Server } from 'node:net';
import type { Snapshot, WireBest, WireQuote } from '../src/shared/wire.js';

const HTTP = 18_080;
const LINK = 17_070;
const LAGGED_LINK = 17_071;
const FEED_HTTP = 18_081;
const token = randomBytes(16).toString('hex');
const base = `http://127.0.0.1:${HTTP}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Health {
  seq: number;
  counters: Record<string, number>;
  books: { book: string; state: string; stale: boolean; lastChangeAt: number | null }[];
  feeds: { feed: string; book: string; healthy: boolean; linked: boolean; frozen: boolean; quotes: number }[];
}

const children = new Set<ChildProcess>();
process.on('exit', () => {
  for (const c of children) c.kill('SIGKILL');
});

function run(entry: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    env: { ...process.env, NODE_ENV: 'development', LOG_LEVEL: 'warn', BOOKS: 'fake', FAKE_RATE: '4', FEED_TOKEN: token, HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}
const startBoard = (env: Record<string, string> = {}) =>
  run('src/server/index.ts', { ROLE: 'board', FEED_ID: 'A', PORT: String(HTTP), FEED_LISTEN: `127.0.0.1:${LINK}`, CHAOS: '1', WEB_DIR: '/nonexistent', ...env });
const startFeed = (port = LINK, env: Record<string, string> = {}) => run('src/feed/index.ts', { ROLE: 'feed', FEED_ID: 'B', PORT: String(FEED_HTTP), FEED_UPSTREAM: `127.0.0.1:${port}`, ...env });

async function stopAll(): Promise<void> {
  for (const c of children) c.kill('SIGKILL');
  while (children.size) await sleep(50);
  await sleep(300);
}

const health = async (): Promise<Health> => (await fetch(`${base}/api/health`)).json() as Promise<Health>;
const board = async (): Promise<Snapshot> => (await fetch(`${base}/api/board`)).json() as Promise<Snapshot>;
const chaos = (book: string, action: 'stop' | 'start') => fetch(`${base}/api/dev/feeds/A/${book}/${action}`, { method: 'POST' });
const book = (h: Health, id: string) => h.books.find((b) => b.book === id)!;
const feedsOf = (h: Health, feed: string) => h.feeds.filter((f) => f.feed === feed);
const picks = (s: Snapshot) => s.bests.filter((b): b is Extract<WireBest, { none?: false }> => !b.none);

/** Polls /api/health until `pred` holds; returns how long that took. */
async function until(what: string, timeoutMs: number, pred: (h: Health) => boolean): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    try {
      if (pred(await health())) return Date.now() - t0;
    } catch {
      // not listening yet
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    await sleep(100);
  }
}

/** Polls /api/health for `ms`; returns the samples that broke `pred` (none = it held throughout). */
async function holds(ms: number, pred: (h: Health) => boolean): Promise<{ samples: number; broken: number; first: Health; last: Health }> {
  const t0 = Date.now();
  let samples = 0;
  let broken = 0;
  const first = await health();
  let last = first;
  while (Date.now() - t0 < ms) {
    last = await health();
    samples++;
    if (!pred(last)) broken++;
    await sleep(100);
  }
  return { samples, broken, first, last };
}

/** Feed B's link with a fixed delay on everything B sends, as a slow path between the boxes would add. */
function laggedLink(delayMs: number): Promise<Server> {
  const server = createServer((fromFeed) => {
    const toBoard = connect(LINK, '127.0.0.1');
    fromFeed.on('data', (chunk) => setTimeout(() => toBoard.write(chunk), delayMs));
    toBoard.on('data', (chunk) => fromFeed.write(chunk));
    const close = () => setTimeout(() => (fromFeed.destroy(), toBoard.destroy()), delayMs);
    fromFeed.on('close', close).on('error', close);
    toBoard.on('close', close).on('error', close);
  });
  return new Promise((resolve) => server.listen(LAGGED_LINK, '127.0.0.1', () => resolve(server)));
}

/** Reads the stream for `ms`: which feed delivered each displayed change, and any book time going backwards. */
async function watchStream(ms: number): Promise<{ changes: number; byFeed: Record<string, number>; backwards: number }> {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const lastBt = new Map<string, number>();
  const byFeed: Record<string, number> = {};
  let changes = 0;
  let backwards = 0;
  let buf = '';
  const see = (q: WireQuote, counted: boolean) => {
    const key = `${q.book}|${q.game}|${q.market}|${q.side}`;
    if (counted) {
      changes++;
      byFeed[q.feed] = (byFeed[q.feed] ?? 0) + 1;
    }
    if (q.bt === null) return;
    if (q.bt < (lastBt.get(key) ?? -Infinity)) backwards++;
    lastBt.set(key, Math.max(q.bt, lastBt.get(key) ?? -Infinity));
  };
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (!data || (event !== 'snapshot' && event !== 'delta')) continue;
        for (const q of (JSON.parse(data) as { quotes?: WireQuote[] }).quotes ?? []) see(q, event === 'delta');
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return { changes, byFeed, backwards };
}

const results: { drill: string; expect: string; observed: string; pass: boolean }[] = [];
function record(drill: string, expect: string, observed: string, pass: boolean): void {
  results.push({ drill, expect, observed, pass });
  console.error(`${pass ? 'PASS' : 'FAIL'}  ${drill}: ${observed}`);
}
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const allHealthy = (h: Health) => h.feeds.length === 4 && h.feeds.every((f) => f.healthy);
const noneStale = (h: Health) => h.books.every((b) => !b.stale);

// ---------------------------------------------------------------- 1. Losing feed B, then a book

startBoard();
startFeed();
record('Start', 'both books live on both feeds', `4 feeds healthy after ${s(await until('4 healthy feeds', 20_000, allHealthy))}`, true);

{
  const feedB = [...children].at(-1)!;
  feedB.kill('SIGKILL');
  const t = await until('B unlinked', 10_000, (h) => feedsOf(h, 'B').every((f) => !f.healthy && !f.linked));
  const window = await holds(10_000, noneStale);
  const moved = window.last.seq - window.first.seq;
  record('Box B crashes (SIGKILL)', 'B marked down at once; A carries both books', `B down in ${s(t)}; 0 stale samples of ${window.samples} over 10 s; ${moved} deltas`, window.broken === 0 && moved > 0);
}
{
  const held = (await health()).counters.massRemovalsHeld ?? 0;
  startFeed();
  const t = await until('B healthy again', 20_000, allHealthy);
  const h = await health();
  record('Box B restarts', 'B back without disturbing the board', `healthy again in ${s(t)}; removals held ${(h.counters.massRemovalsHeld ?? 0) - held}`, (h.counters.massRemovalsHeld ?? 0) === held);
}
{
  const feedB = [...children].at(-1)!;
  feedB.kill('SIGSTOP'); // alive but silent: no FIN, so only the link's silence timer can notice
  const t = await until('B unlinked after silence', 15_000, (h) => feedsOf(h, 'B').every((f) => !f.linked));
  const stale = (await health()).books.some((b) => b.stale);
  feedB.kill('SIGCONT');
  const back = await until('B relinked', 30_000, allHealthy);
  record('Box B hangs (SIGSTOP)', 'link silence detected in ~5 s; B relinks after', `unlinked after ${s(t)}; books stale: ${stale}; relinked ${s(back)} after resuming`, !stale && t < 8_000);
}
{
  await chaos('draftkings', 'stop');
  const before = book(await health(), 'draftkings').lastChangeAt ?? 0;
  const window = await holds(10_000, (h) => !book(h, 'draftkings').stale);
  const after = book(window.last, 'draftkings').lastChangeAt ?? 0;
  record('DraftKings stops on Box A', 'B carries DraftKings', `0 stale samples of ${window.samples}; DK still moving: ${after > before}`, window.broken === 0 && after > before);
}
{
  const feedB = [...children].at(-1)!;
  feedB.kill('SIGKILL');
  const t = await until('DK stale', 40_000, (h) => book(h, 'draftkings').stale);
  const h = await health();
  await sleep(1_500);
  const snap = await board();
  const usesDk = picks(snap).filter((b) => b.books.includes('draftkings')).length;
  record(
    '…and Box B crashes too',
    'DK stale (every feed down), out of Best Price; FD unaffected',
    `DK stale after ${s(t)}; FD stale: ${book(h, 'fanduel').stale}; best prices using DK: ${usesDk} of ${picks(snap).length}`,
    !book(h, 'fanduel').stale && usesDk === 0,
  );
}
{
  await chaos('draftkings', 'start');
  const t = await until('DK live', 20_000, (h) => !book(h, 'draftkings').stale && book(h, 'draftkings').state === 'live');
  await sleep(1_500);
  const usesDk = picks(await board()).filter((b) => b.books.includes('draftkings')).length;
  record('DraftKings returns on Box A', 'DK live and back in Best Price', `live after ${s(t)}; best prices using DK: ${usesDk}`, usesDk > 0);
}
await stopAll();

// ---------------------------------------------------------------- 2. Feed B two seconds behind

{
  const proxy = await laggedLink(2_000);
  startBoard();
  startFeed(LAGGED_LINK);
  await until('4 healthy feeds (lagged)', 30_000, allHealthy);
  const h0 = await health();
  const seen = await watchStream(60_000);
  const h1 = await health();
  const delta = (k: string) => (h1.counters[k] ?? 0) - (h0.counters[k] ?? 0);
  record(
    "Box B's link 2 s behind",
    'B never shows first; no price moves backwards',
    `${seen.changes} changes in 60 s: ${Object.entries(seen.byFeed)
      .map(([f, n]) => `${n} via ${f}`)
      .join(', ')}; book time backwards: ${seen.backwards}; heals ${delta('heals')}`,
    (seen.byFeed.B ?? 0) === 0 && seen.backwards === 0 && delta('heals') === 0,
  );
  await stopAll();
  proxy.close();
}

// ---------------------------------------------------------------- 3. Bad data, mass removal, a frozen feed

{
  startBoard({ FAKE_MODE_FD: 'garbage' });
  startFeed(LINK, { FAKE_MODE_DK: 'freeze', FAKE_MODE_FD: 'massRemove' });
  const phase3 = Date.now();
  await until('4 healthy feeds (faults)', 20_000, allHealthy);
  const fdQuotes = (h: Health) => feedsOf(h, 'A').find((f) => f.book === 'fanduel')!.quotes;
  const full = fdQuotes(await health());

  const tHold = await until('mass removal held', 30_000, (h) => (h.counters.massRemovalsHeld ?? 0) > 0);
  await sleep(20_000); // past the 15 s hold
  const snap = await board();
  const onBoard = snap.quotes.filter((q) => q.book === 'fanduel').length;
  const bFd = feedsOf(await health(), 'B').find((f) => f.book === 'fanduel')!.quotes;
  record(
    "Box B's FanDuel drops 80% of quotes",
    'held 15 s; then the board keeps what Box A still lists',
    `held after ${s(tHold)}; B lists ${bFd}, board shows ${onBoard} of ${full}`,
    onBoard === full && bFd < full,
  );

  const invalid = (await health()).counters.invalidQuotes ?? 0;
  const shown = snap.quotes.filter((q) => Math.abs(q.american) < 100).length;
  record("Box A's FanDuel sends invalid prices", 'dropped and counted; none displayed', `${invalid} dropped; ${shown} displayed`, invalid > 0 && shown === 0);

  // B's DraftKings stays connected but stops changing 15 s in; the watchdog needs 90 s of silence.
  const bDk = (h: Health) => feedsOf(h, 'B').find((f) => f.book === 'draftkings')!;
  await until("watchdog flags B's DraftKings as frozen", 150_000, (h) => bDk(h).frozen);
  const h = await health();
  const back = await until("B's DraftKings restarted and moving", 30_000, (x) => !bDk(x).frozen && bDk(x).healthy);
  record(
    "Box B's DraftKings freezes (connected, no changes)",
    'watchdog excludes and restarts it; DK stays live',
    `flagged ${s(Date.now() - phase3 - back)} after B started; restarts ${h.counters.watchdogRestarts ?? 0}; DK stale: ${book(h, 'draftkings').stale}; healthy again ${s(back)} later`,
    (h.counters.watchdogRestarts ?? 0) > 0 && !book(h, 'draftkings').stale,
  );
  await stopAll();
}

console.log(`| Drill | Expected | Observed | |\n|---|---|---|---|`);
for (const r of results) console.log(`| ${r.drill} | ${r.expect} | ${r.observed} | ${r.pass ? 'pass' : '**FAIL**'} |`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
