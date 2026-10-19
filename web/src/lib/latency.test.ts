import { describe, expect, it } from 'vitest';
import type { LatencyReport } from '@shared/wire';
import { delta, quote } from '../test/fixtures';
import { LatencyRecorder, type LatencyOptions } from './latency';

function setup(over: Partial<LatencyOptions> = {}) {
  const frames: Array<() => void> = [];
  const sent: Array<{ url: string; body: LatencyReport }> = [];
  let perf = 0;
  let hidden = false;
  const clock = { offset: 250, err: 4, synced: true };
  const rec = new LatencyRecorder({
    clock,
    nextFrame: (cb) => frames.push(cb),
    send: (url, body) => {
      sent.push({ url, body: JSON.parse(body) as LatencyReport });
      return true;
    },
    perfNow: () => perf,
    random: () => 0.99,
    isHidden: () => hidden,
    events: null,
    ...over,
  });
  return {
    rec,
    sent,
    clock,
    /** Runs the pending frame callbacks, then lets their microtasks settle. */
    runFrame: async (at: number) => {
      perf = at;
      frames.splice(0).forEach((f) => f());
      await Promise.resolve();
    },
    setHidden: (h: boolean) => (hidden = h),
  };
}

describe('LatencyRecorder', () => {
  it('measures each quote of a live delta on the server clock, with paint at the next frame', async () => {
    const { rec, sent, runFrame } = setup();
    const d = delta(11, {
      ts: 10_000,
      quotes: [
        quote('draftkings', { rx: 9_900, bt: 9_700, ch: 'push', feed: 'A', live: true }),
        quote('fanduel', { rx: 9_950, bt: null, ch: 'poll', feed: 'B' }),
      ],
    });
    rec.record(d, 10_000, 100); // browser clock 10 000 → server clock 10 250
    expect(rec.size).toBe(0); // waits for the frame
    await runFrame(116.4);
    expect(rec.flush()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('/api/latency');
    expect(sent[0]!.body).toEqual({
      v: 1,
      offsetMs: 250,
      offsetErrMs: 4,
      samples: [
        { book: 'draftkings', phase: 'live', ch: 'push', feed: 'A', serverToBrowser: 250, rxToBrowser: 350, bookToBrowser: 550, paint: 16.4 },
        { book: 'fanduel', phase: 'pre', ch: 'poll', feed: 'B', serverToBrowser: 250, rxToBrowser: 300, bookToBrowser: null, paint: 16.4 },
      ],
    });
    expect(rec.flush()).toBe(false); // drained
  });

  it('skips deltas without quotes, hidden tabs and an unsynced clock', async () => {
    const unsynced = setup();
    unsynced.clock.synced = false;
    unsynced.rec.record(delta(11, { quotes: [quote('draftkings')] }), 0, 0);
    await unsynced.runFrame(10);
    expect(unsynced.rec.size).toBe(0);

    const { rec, runFrame, setHidden } = setup();
    rec.record(delta(11, { bests: [] }), 0, 0);
    setHidden(true);
    rec.record(delta(12, { quotes: [quote('draftkings')] }), 0, 0);
    await runFrame(10);
    expect(rec.size).toBe(0);
  });

  it('caps a report with a reservoir sample', async () => {
    const { rec, runFrame, sent } = setup({ cap: 3 });
    for (let i = 0; i < 10; i++) rec.record(delta(11 + i, { quotes: [quote('draftkings')] }), 0, 0);
    await runFrame(5);
    expect(rec.size).toBe(3);
    rec.flush();
    expect(sent[0]!.body.samples).toHaveLength(3);
  });
});
