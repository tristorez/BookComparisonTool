import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/server/app.js';
import { Board } from '../src/server/board.js';
import { LatencyTracker } from '../src/server/latency.js';
import { BOOKS } from '../src/server/registry.js';
import { SseHub } from '../src/server/sse.js';
import { MAX_BEACON_SAMPLES, type LatencyReport, type LatencySample } from '../src/shared/wire.js';

const sample = (o: Record<string, unknown> = {}): LatencySample =>
  ({ book: 'draftkings', phase: 'live', ch: 'push', feed: 'A', serverToBrowser: 40, rxToBrowser: 60, bookToBrowser: 120, paint: 8, ...o }) as LatencySample;
const report = (samples: LatencySample[]): LatencyReport => ({ v: 1, offsetMs: 0, offsetErrMs: 12, samples });

describe('LatencyTracker beacons', () => {
  it('lets only configured books, real channels and feeds that delivered a first copy name a series', () => {
    const t = new LatencyTracker({ draftkings: 0, fanduel: 1_000 });
    t.firstCopy('draftkings', 'A');
    const junk = [
      sample({ book: 'constructor' }), // inherited from Object.prototype
      sample({ book: 'nonsense' }),
      sample({ ch: 'carrier-pigeon' }),
      sample({ feed: 'Z' }), // never delivered anything
    ];
    expect(t.ingest(report(junk))).toBe(0);
    expect(t.snapshot().series.map((s) => s.metric)).toEqual(['browserClockError']);

    expect(t.ingest(report([sample()]))).toBe(1);
    expect(t.snapshot().series.map((s) => s.metric).sort()).toEqual(['bookToBrowser', 'browserClockError', 'paint', 'rxToBrowser', 'serverToBrowser']);
  });

  it('accepts a full beacon over HTTP: the busiest windows fill one, and must not be refused as too large', async () => {
    const latency = new LatencyTracker({ draftkings: 0, fanduel: 1_000 });
    latency.firstCopy('draftkings', 'A');
    const board = new Board({ books: [BOOKS.draftkings, BOOKS.fanduel], staleGraceMs: 5_000 });
    const hub = new SseHub(board);
    const app = await buildApp({ board, hub, latency, cfg: { logLevel: 'error', chaos: false, webDir: '/nonexistent' }, logger: false });
    try {
      // Six-digit timings: the widest a real sample gets inside the tracker's accepted range.
      const full = report(Array.from({ length: MAX_BEACON_SAMPLES }, () => sample({ serverToBrowser: 123_456, rxToBrowser: 123_456, bookToBrowser: 123_456, paint: 1_234.5 })));
      // navigator.sendBeacon posts the report as an application/json Blob.
      const res = await app.inject({ method: 'POST', url: '/api/latency', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(full) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ accepted: MAX_BEACON_SAMPLES });
    } finally {
      hub.close();
      await app.close();
    }
  });
});
