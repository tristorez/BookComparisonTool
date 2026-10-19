/** HTTP surface: the SSE stream, JSON endpoints, browser latency beacons, and the built web app. */
import { existsSync } from 'node:fs';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { BookId } from '../shared/domain.js';
import type { LatencyReport, TimeResponse } from '../shared/wire.js';
import type { Board } from './board.js';
import type { Config } from './config.js';
import type { LatencyTracker } from './latency.js';
import type { SseHub } from './sse.js';

export interface AppDeps {
  board: Board;
  hub: SseHub;
  latency: LatencyTracker;
  cfg: Pick<Config, 'logLevel' | 'chaos' | 'webDir'>;
  /** Dev-only (CHAOS=1): stop/start one box's connector for a book, to demo the stale UI. */
  chaos?: (feed: string, book: BookId, action: 'stop' | 'start') => Promise<boolean>;
  extraHealth?: () => Record<string, unknown>;
  logger?: boolean;
}

/** Beacons per IP per minute; each holds at most 200 samples (enforced by the tracker). */
const BEACONS_PER_MINUTE = 10;

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { board, hub, latency, cfg } = deps;
  const app = Fastify({ logger: deps.logger === false ? false : { level: cfg.logLevel }, trustProxy: true, bodyLimit: 16 * 1024 });

  // The SSE route hijacks its reply, so compression never touches the stream.
  await app.register(fastifyCompress, { global: true, threshold: 1_024 });
  // navigator.sendBeacon posts strings as text/plain.
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get('/healthz', async () => ({ ok: true })); // process liveness only, never book state
  app.get('/api/stream', (req, reply) => hub.handle(req, reply));
  app.get('/api/board', async () => board.snapshot());
  app.get('/api/time', async (): Promise<TimeResponse> => ({ now: Date.now() }));
  app.get('/api/health', async () => ({ ...board.health(), sse: hub.stats(), uptimeSec: Math.round(process.uptime()), ...deps.extraHealth?.() }));
  app.get('/api/metrics', async () => ({ latency: latency.snapshot(), sse: hub.stats(), board: board.counters }));

  const beacons = new Map<string, { windowStart: number; count: number }>();
  app.post('/api/latency', async (req, reply) => {
    const now = Date.now();
    const b = beacons.get(req.ip);
    if (!b || now - b.windowStart > 60_000) beacons.set(req.ip, { windowStart: now, count: 1 });
    else if (++b.count > BEACONS_PER_MINUTE) return reply.code(429).send({ error: 'too many latency reports' });
    if (beacons.size > 10_000) beacons.clear();
    return { accepted: latency.ingest(req.body as LatencyReport) };
  });

  if (cfg.chaos && deps.chaos) {
    app.post<{ Params: { feed: string; book: BookId; action: 'stop' | 'start' } }>('/api/dev/feeds/:feed/:book/:action', async (req, reply) => {
      const { feed, book, action } = req.params;
      if (action !== 'stop' && action !== 'start') return reply.code(400).send({ error: 'action must be stop or start' });
      const ok = await deps.chaos!(feed, book, action);
      return ok ? { ok } : reply.code(404).send({ error: `no local feed ${feed}/${book}` });
    });
  }

  if (existsSync(cfg.webDir)) {
    await app.register(fastifyStatic, { root: cfg.webDir, wildcard: false, maxAge: '1h', immutable: false });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.type('text/html').sendFile('index.html')));
  }
  return app;
}
