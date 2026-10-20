import { afterEach, describe, expect, it, vi } from 'vitest';
import { FanDuelConnector } from '../src/books/fanduel.js';

/**
 * FanDuel's SMP poll loop on wall-clock slots (Decisions.txt D-36): the real schedulePoll under fake
 * timers, with only the network call stubbed. Box A polls at phase 0, Box B at 500 ms.
 */
interface PollInternals {
  running: boolean;
  schedulePoll(delayMs: number): void;
  fetchPrices(ids: string[], channel: string): Promise<void>;
}

const START = Date.UTC(2026, 9, 25, 17, 0, 0) + 137; // a whole second + 137 ms: off the slot grid

/** Runs one connector's poll loop; `fetch` is the stubbed request, called with the poll's index. */
async function polls(phaseMs: number, runMs: number, fetch: (i: number) => Promise<void> = async () => {}): Promise<number[]> {
  vi.useFakeTimers({ now: START });
  const c = new FanDuelConnector({ push: false, pollIntervalMs: 1_000, pollPhaseMs: phaseMs });
  const loop = c as unknown as PollInternals;
  const at: number[] = [];
  loop.running = true;
  loop.fetchPrices = async () => {
    at.push(Date.now());
    await fetch(at.length - 1);
  };
  loop.schedulePoll(0);
  await vi.advanceTimersByTimeAsync(runMs);
  loop.running = false;
  vi.useRealTimers();
  return at;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const msPastSecond = (t: number) => t % 1_000;

describe('FanDuel poll phase', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on phase + k × interval after the first poll, whatever each request takes', async () => {
    const took = [40, 310, 880, 15, 990, 120, 600, 5, 450, 270];
    const at = await polls(500, 10_500, (i) => wait(took[i % took.length]!));
    expect(at.length).toBeGreaterThanOrEqual(10);
    for (const t of at.slice(1)) expect(msPastSecond(t)).toBe(500);
  });

  it('interleaves two hosts at phases 0 and 500 into one poll every 500 ms', async () => {
    const a = await polls(0, 8_000, () => wait(90));
    const b = await polls(500, 8_000, () => wait(160));
    const merged = [...a.slice(1), ...b.slice(1)].sort((x, y) => x - y);
    const gaps = merged.slice(1).map((t, i) => t - merged[i]!);
    expect(new Set(gaps)).toEqual(new Set([500]));
  });

  it('keeps one poll loop when the connector is restarted while a poll is in flight', async () => {
    vi.useFakeTimers({ now: START });
    const c = new FanDuelConnector({ push: false, pollIntervalMs: 1_000 });
    const fd = c as unknown as PollInternals & { runDiscovery(): Promise<void> };
    fd.runDiscovery = async () => {}; // no board reads: only the poll loop runs
    const at: number[] = [];
    let release: (() => void) | undefined;
    fd.fetchPrices = async () => {
      at.push(Date.now());
      if (at.length === 2 && release === undefined) await new Promise<void>((r) => (release = r)); // the second poll hangs
    };
    await c.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(release).toBeDefined();
    // The watchdog's restart (and the chaos routes) stop and start the same instance.
    await c.stop();
    await c.start();
    release!(); // the first run's poll completes after the second run has started its own loop
    at.length = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    await c.stop();
    expect(at.length).toBeGreaterThanOrEqual(4);
    expect(new Set(at).size).toBe(at.length); // two loops would poll twice per slot
  });

  it('does not drift after a stalled process or a slow request: it skips to the next slot', async () => {
    const at = await polls(0, 9_000, async (i) => {
      if (i === 2) vi.setSystemTime(Date.now() + 1_730); // the event loop was blocked; the clock moved on
      if (i === 4) await wait(1_300); // slower than the interval: never two polls in flight
    });
    for (const t of at.slice(1)) expect(msPastSecond(t)).toBe(0);
    const gaps = at.slice(1).map((t, i) => t - at[i]!);
    expect(gaps[2]).toBe(2_000); // a 1,730 ms stall: the slot it covered is skipped, not shifted
    expect(gaps[4]).toBe(2_000); // 1,300 ms request: one slot skipped
  });
});
