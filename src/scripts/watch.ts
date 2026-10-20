/**
 * Run book connectors from the terminal and print normalized changes plus latency stats. Books come from
 * the registry (src/server/registry.ts), so a new connector can be watched here before it is on the board.
 *
 *   npm run watch:fd                     # FanDuel only
 *   npm run watch:dk                     # DraftKings only
 *   npm run watch                        # every book, with a side-by-side board in each summary
 *   npm run watch -- <book id>           # any registered book
 *
 * Env: the board's connector settings (src/server/config.ts, .env.example), e.g. FD_REGION, FD_POLL_MS,
 *      FD_POLL_PHASE_MS, FD_PUSH=0, FD_APP_KEY (start from a wrong key, e.g. x, to watch the connector
 *      fetch FanDuel's current keys from its bundle), FD_PIR_KEY, DK_STATE, DK_PROXY_URL, DK_REST_PROXY_URL,
 *      DK_WS_PROXY_URL, DK_TOKEN_MODE, or BOOKS=fake for synthetic books; plus WATCH_SECONDS (exit after N
 *      seconds), WATCH_SUMMARY_MS (default 30000), WATCH_QUIET=1.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { BookConnector, BookId, MarketType, Quote, Side } from '../books/types.js';
import { ConfigError, loadConfig, type Config } from '../server/config.js';
import { BOOKS, createConnector } from '../server/registry.js';
import { BOOK_IDS } from '../shared/domain.js';

const env = process.env;
const which = process.argv[2] ?? 'all';
const quiet = env.WATCH_QUIET === '1';
const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v));

const books = BOOK_IDS.filter((b) => which === 'all' || b === which);
if (!books.length) {
  console.error(`usage: watch.ts [${[...BOOK_IDS, 'all'].join('|')}]`);
  process.exit(1);
}
let cfg: Config;
try {
  cfg = loadConfig(env);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`config error: ${err.message}`);
  process.exit(2);
}
const connectors: BookConnector[] = books.map((b) => createConnector(b, cfg));

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const short = (book: BookId) => BOOKS[book].short;
const fmtOdds = (a: number) => (a > 0 ? `+${a}` : `${a}`);
const fmtLine = (q: Quote) => (q.line === null ? '' : q.market === 'spread' && q.line > 0 ? `+${q.line}` : `${q.line}`);

/** book→backend lag (receivedAt - bookTime) per book/channel/phase, for push frames that carry a book timestamp. */
const lags = new Map<string, number[]>();
const counts = new Map<string, number>();

for (const c of connectors) {
  c.on('log', (m) => console.log(ts(), m));
  c.on('status', (s) => console.log(ts(), `STATUS ${short(s.book)} → ${s.state}${s.detail ? ` (${s.detail})` : ''}`));
  c.on('change', (ch) => {
    for (const q of ch.quotes) {
      const key = `${short(q.book)} ${q.channel.padEnd(8)} ${q.live ? 'live' : 'pre '}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (q.bookTime !== null) {
        const list = lags.get(key) ?? [];
        list.push(q.receivedAt - q.bookTime);
        lags.set(key, list);
      }
    }
    if (quiet) return;
    if (ch.quotes.length > 12) {
      console.log(ts(), `${short(ch.book)} ${ch.quotes.length} quotes via ${ch.quotes[0]!.channel}, ${ch.games.length} games`);
    } else {
      for (const q of ch.quotes) {
        const lag = q.bookTime !== null ? ` lag ${q.receivedAt - q.bookTime}ms` : '';
        console.log(
          ts(),
          `${short(q.book)} ${q.gameKey.padEnd(20)} ${q.market.padEnd(9)} ${q.side.padEnd(5)} ${fmtLine(q).padStart(6)} ${fmtOdds(q.american).padStart(6)}` +
            `${q.suspended ? ' SUSP' : ''}${q.live ? ' LIVE' : ''}  [${q.channel}${lag}]`,
        );
      }
    }
    for (const r of ch.removedQuotes) console.log(ts(), `${short(ch.book)} removed ${r.gameKey} ${r.market} ${r.side}`);
    for (const g of ch.removedGames) console.log(ts(), `${short(ch.book)} removed game ${g}`);
  });
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

// Process cost, for sizing the host: CPU share and event-loop delay since the previous summary.
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
loopDelay.enable();
let cpuMark = process.cpuUsage();
let cpuMarkAt = Date.now();

function summary(): void {
  console.log(`\n${ts()} ───────── summary ─────────`);
  const cpu = process.cpuUsage(cpuMark);
  const cpuPct = ((cpu.user + cpu.system) / 1000 / Math.max(1, Date.now() - cpuMarkAt)) * 100;
  // The histogram includes the 10ms sampling interval itself; report only the lag beyond it.
  const lag = (p: number) => Math.max(0, loopDelay.percentile(p) / 1e6 - 10).toFixed(1);
  console.log(
    `process: rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB · cpu ${cpuPct.toFixed(1)}% of one core · ` +
      `event-loop lag p50 ${lag(50)} ms p99 ${lag(99)} ms max ${lag(100)} ms`,
  );
  cpuMark = process.cpuUsage();
  cpuMarkAt = Date.now();
  loopDelay.reset();
  for (const c of connectors) {
    const snap = c.snapshot();
    const age = snap.status.lastDataAt ? `${((Date.now() - snap.status.lastDataAt) / 1000).toFixed(1)}s ago` : 'never';
    console.log(`${short(c.book)}: ${snap.status.state}${snap.status.detail ? ` (${snap.status.detail})` : ''} · ${snap.games.length} games · ${snap.quotes.length} quotes · last data ${age}`);
  }
  for (const [key, n] of [...counts].sort()) {
    const l = lags.get(key);
    const stats = l?.length ? `  book→backend p50 ${pct(l, 0.5)}ms p90 ${pct(l, 0.9)}ms max ${Math.max(...l)}ms (n=${l.length})` : '';
    console.log(`  ${key}: ${n} quote changes${stats}`);
  }
  if (connectors.length > 1) printBoard();
  console.log('');
}

/** Side-by-side main lines (one cell per book), to eyeball that every book's games and sides line up. */
function printBoard(): void {
  const rows = new Map<string, Map<string, Quote>>();
  for (const c of connectors) {
    for (const q of c.snapshot().quotes) {
      const row = rows.get(q.gameKey) ?? new Map<string, Quote>();
      row.set(`${q.book}|${q.market}|${q.side}`, q);
      rows.set(q.gameKey, row);
    }
  }
  const books = connectors.map((c) => c.book);
  const codes = books.map(short).join(' / ');
  const [mlWidth, spreadWidth] = [9 * books.length + 1, 13 * books.length + 1];
  const cell = (q?: Quote) => (q ? `${fmtLine(q)} ${fmtOdds(q.american)}`.trim() + (q.suspended ? '*' : '') : '—');
  const cells = (row: Map<string, Quote>, market: MarketType, side: Side) => books.map((b) => cell(row.get(`${b}|${market}|${side}`))).join(' / ');
  console.log(`  ${'game'.padEnd(20)} ${'side'.padEnd(5)} | ${`ML  ${codes}`.padEnd(mlWidth)} | ${`spread  ${codes}`.padEnd(spreadWidth)} | total  ${codes}`);
  for (const [game, row] of [...rows].sort()) {
    for (const [side, tside] of [['away', 'over'], ['home', 'under']] as const) {
      const ml = cells(row, 'moneyline', side);
      const sp = cells(row, 'spread', side);
      const to = `${tside[0]} ${cells(row, 'total', tside)}`;
      console.log(`  ${(side === 'away' ? game : '').padEnd(20)} ${side.padEnd(5)} | ${ml.padEnd(mlWidth)} | ${sp.padEnd(spreadWidth)} | ${to}`);
    }
  }
}

const summaryEvery = num(env.WATCH_SUMMARY_MS) ?? 30_000;
const interval = setInterval(summary, summaryEvery);
await Promise.all(connectors.map((c) => c.start()));

const shutdown = async () => {
  clearInterval(interval);
  summary();
  await Promise.all(connectors.map((c) => c.stop()));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
const seconds = num(env.WATCH_SECONDS);
if (seconds) setTimeout(shutdown, seconds * 1000);
