/**
 * Feed box (ROLE=feed, Box B): this box's connectors → feed link → Box A's board. A second,
 * independent IP for both books; its FanDuel polls run half a second after Box A's.
 *
 *   ROLE=feed FEED_UPSTREAM=<box A private ip>:7070 FEED_TOKEN=... FD_POLL_PHASE_MS=500 npm run start:feed
 */
import { createServer } from 'node:http';
import type { BookConnector } from '../books/types.js';
import { FeedLinkClient } from '../feedlink/client.js';
import { ConfigError, loadConfig, type Config } from '../server/config.js';
import { createConnector } from '../server/registry.js';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

let cfg: Config;
try {
  cfg = loadConfig({ ...process.env, ROLE: process.env.ROLE ?? 'feed' });
  if (cfg.role !== 'feed') throw new ConfigError('this entry point is a feed; run dist/server/index.js for ROLE=board');
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`config error: ${err.message}`);
  process.exit(2);
}

process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));

const link = new FeedLinkClient({ upstream: cfg.feedUpstream!, token: cfg.feedToken!, feedId: cfg.feedId, log });
const connectors: BookConnector[] = [];
for (const book of cfg.books) {
  const c = createConnector(book, cfg);
  c.on('log', log);
  link.attach(book, c);
  connectors.push(c);
}

// Local-only liveness for systemd and operators: process health, never book state.
const health = createServer((req, res) => {
  if (req.url !== '/healthz') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, feedId: cfg.feedId, linked: link.linked, link: link.counters, books: connectors.map((c) => c.status) }));
});
health.listen(cfg.http.port, '127.0.0.1');

link.start();
log(`feed ${cfg.feedId} → ${cfg.feedUpstream!.host}:${cfg.feedUpstream!.port} (books: ${cfg.fake ? 'fake' : cfg.books.join(', ')}, FD poll phase ${cfg.fd.pollPhaseMs}ms)`);
await Promise.all(connectors.map((c) => c.start()));

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  log(`${signal}: shutting down`);
  link.stop();
  await Promise.all(connectors.map((c) => c.stop()));
  health.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
