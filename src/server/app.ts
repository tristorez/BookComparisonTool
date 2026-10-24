/** HTTP surface: the SSE stream, JSON endpoints, browser latency beacons, and the built web app. */
import { existsSync } from 'node:fs';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { BookId } from '../shared/domain.js';
import { isPropGroup, PROP_GROUPS } from '../shared/props.js';
import type { LatencyReport, TimeResponse } from '../shared/wire.js';
import type { Board } from './board.js';
import type { Config } from './config.js';
import type { LatencyTracker } from './latency.js';
import type { PropsService } from './props.js';
import type { SseHub } from './sse.js';

export interface AppDeps {
  board: Board;
  hub: SseHub;
  latency: LatencyTracker;
  /** Player props for the game page (on demand; no route without it). */
  props?: Pick<PropsService, 'get' | 'counters'>;
  cfg: Pick<Config, 'logLevel' | 'chaos' | 'webDir'>;
  /** Dev-only (CHAOS=1): stop/start one box's connector for a book, to demo the stale UI. */
  chaos?: (feed: string, book: BookId, action: 'stop' | 'start') => Promise<boolean>;
  extraHealth?: () => Record<string, unknown>;
  logger?: boolean;
}

/** Beacons per IP per minute; each holds at most MAX_BEACON_SAMPLES samples (enforced by the tracker). */
const BEACONS_PER_MINUTE = 10;
/**
 * Body limit for `POST /api/latency` only. A full beacon (MAX_BEACON_SAMPLES samples at ~136 bytes) is
 * ~41 KB, well past the app-wide 16 KB limit, which would reject the busiest windows outright (HTTP 413).
 * 64 KiB is the most `navigator.sendBeacon` will queue anyway.
 */
const BEACON_BODY_LIMIT = 64 * 1024;

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
  app.get('/api/metrics', async () => ({ latency: latency.snapshot(), sse: hub.stats(), board: board.counters, props: deps.props?.counters ?? null }));

  const props = deps.props;
  if (props) {
    app.get<{ Params: { game: string }; Querystring: { group?: string } }>('/api/games/:game/props', async (req, reply) => {
      const group = req.query.group ?? PROP_GROUPS[0];
      if (!isPropGroup(group)) return reply.code(400).send({ error: `group must be one of ${PROP_GROUPS.join(', ')}` });
      const res = await props.get(req.params.game, group);
      if (res === null) return reply.code(404).send({ error: 'game not on the board' });
      // Reads are shared server-side for a few seconds; a browser cache would only add staleness on top.
      return reply.header('cache-control', 'no-cache').send(res);
    });
  }

  // Fixed one-minute window per client IP; the map is simply cleared if it ever grows past 10k IPs.
  const beacons = new Map<string, { windowStart: number; count: number }>();
  app.post('/api/latency', { bodyLimit: BEACON_BODY_LIMIT }, async (req, reply) => {
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
    await app.register(fastifyStatic, {
      root: cfg.webDir,
      wildcard: false,
      // Vite fingerprints everything under assets/, so those are cached for good. index.html is revalidated on
      // every load, so a deploy reaches returning visitors at once and no cached page names deleted assets.
      cacheControl: false,
      setHeaders: (reply, filePath) => reply.header('cache-control', /[\\/]assets[\\/]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache'),
    });
    // Client-side URLs (e.g. `/?game=…` reloaded) get the app shell. A missing API route or asset is a real
    // 404: answering an old asset URL with HTML would hand the browser a page where it expects a script.
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') || req.url.startsWith('/assets/') ? reply.code(404).send({ error: 'not found' }) : reply.type('text/html').sendFile('index.html'),
    );
  }
  return app;
}
