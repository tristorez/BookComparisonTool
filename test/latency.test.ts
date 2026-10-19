import { describe, expect, it } from 'vitest';
import { LatencyTracker } from '../src/server/latency.js';
import type { LatencyReport, LatencySample } from '../src/shared/wire.js';

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
});
