import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Board } from '../src/server/board.js';
import { LatencyTracker } from '../src/server/latency.js';
import { BOOKS } from '../src/server/registry.js';
import { SseHub } from '../src/server/sse.js';

/** The built site as `vite build` lays it out: index.html plus fingerprinted files under assets/. */
describe('serving the web app', () => {
  let dir: string;
  let hub: SseHub;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'odds-web-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><script type="module" src="/assets/index-abc123.js"></script>');
    writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log("app")');
    const board = new Board({ books: [BOOKS.draftkings, BOOKS.fanduel], staleGraceMs: 5_000 });
    hub = new SseHub(board);
    app = await buildApp({ board, hub, latency: new LatencyTracker(), cfg: { logLevel: 'error', chaos: false, webDir: dir }, logger: false });
  });

  afterAll(async () => {
    hub.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('revalidates the page on every load, so a deploy reaches returning visitors at once', async () => {
    for (const url of ['/', '/index.html', '/?game=2026-10-25:PIT@NO']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['content-type'], url).toMatch(/^text\/html/);
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
  });

  it('caches fingerprinted assets for good', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('answers a missing asset or API route with a 404, never with the page', async () => {
    for (const url of ['/assets/index-OLDHASH.js', '/api/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.headers['content-type'], url).toMatch(/^application\/json/);
    }
  });
});
