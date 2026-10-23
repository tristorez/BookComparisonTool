/**
 * Board box (ROLE=board, Box A): this box's connectors (feed A) + Box B's feed link → board → SSE + site.
 *
 *   npm run dev            # with the Vite dev server
 *   BOOKS=fake npm run dev # synthetic books, no network
 *   npm run build && npm start
 */
import type { BookConnector } from '../books/types.js';
import { FeedLinkServer } from '../feedlink/server.js';
import type { BookId } from '../shared/domain.js';
import { buildApp } from './app.js';
import { Board } from './board.js';
import { ConfigError, loadConfig, loadLocalEnv, type Config } from './config.js';
import { LatencyTracker } from './latency.js';
import { PropsService, type PropsReader } from './props.js';
import { BOOKS, createConnector, regionOf } from './registry.js';
import { SseHub } from './sse.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

let cfg: Config;
try {
  loadLocalEnv();
  cfg = loadConfig();
  if (cfg.role !== 'board') throw new ConfigError('this entry point is the board; run dist/feed/index.js for ROLE=feed');
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`config error: ${err.message}`);
  process.exit(2);
}

process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));

const latency = new LatencyTracker(Object.fromEntries(cfg.books.map((b) => [b, BOOKS[b].bookTimeResolutionMs])));
const board = new Board({ books: cfg.books.map((b) => ({ ...BOOKS[b], region: regionOf(b, cfg) })), staleGraceMs: cfg.staleGraceMs, staleAfterMs: cfg.staleAfterMs, latency, log });

async function restart(c: BookConnector): Promise<void> {
  log(`restarting ${c.book} (watchdog)`);
  await c.stop();
  await new Promise((r) => setTimeout(r, 2_000));
  await c.start();
}

// Attach every feed before any connector starts: connectors emit during start().
const connectors = new Map<BookId, BookConnector>();
for (const book of cfg.books) {
  const c = createConnector(book, cfg);
  const feed = board.addFeed(cfg.feedId, book, { getStatus: () => c.status, restart: () => restart(c) });
  c.on('change', feed.change);
  c.on('sample', feed.samples);
  c.on('status', feed.status);
  c.on('log', log);
  connectors.set(book, c);
}

const hub = new SseHub(board, { log });
const feedLink = cfg.feedListen ? new FeedLinkServer({ board, books: cfg.books, token: cfg.feedToken!, latency, log }) : null;
// Player props are read on demand through this box's connectors (their HTTP clients and keys); never streamed.
const readers: Partial<Record<BookId, PropsReader>> = {};
for (const [book, c] of connectors) if (c.fetchProps) readers[book] = c.fetchProps.bind(c);
const props = new PropsService({
  books: cfg.books,
  games: (game) => board.bookGames(game),
  readers,
  bookDown: (book) => board.bookStatus(book).stale,
  ttlMs: cfg.propsTtlMs,
  log,
});

const app = await buildApp({
  board,
  hub,
  latency,
  props,
  cfg,
  chaos: async (feed, book, action) => {
    const c = feed === cfg.feedId ? connectors.get(book) : undefined;
    if (!c) return false;
    await (action === 'stop' ? c.stop() : c.start());
    return true;
  },
  extraHealth: () => ({ role: cfg.role, feedId: cfg.feedId, feedLink: feedLink?.status() ?? null, listenerErrors: Object.fromEntries([...connectors].map(([b, c]) => [b, c.listenerErrors])) }),
});

await app.listen({ host: cfg.http.host, port: cfg.http.port });
if (feedLink && cfg.feedListen) await feedLink.listen(cfg.feedListen);
const tick = setInterval(() => board.tick(), 1_000);
log(`board ${board.boot} serving on ${cfg.http.host}:${cfg.http.port} (books: ${cfg.fake ? 'fake' : cfg.books.join(', ')})`);
await Promise.all([...connectors.values()].map((c) => c.start()));

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log(`${signal}: shutting down`);
  clearInterval(tick);
  hub.close();
  await feedLink?.close();
  await Promise.all([...connectors.values()].map((c) => c.stop()));
  await app.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
