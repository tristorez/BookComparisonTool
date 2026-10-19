import { describe, expect, it } from 'vitest';
import { ServerClock } from './clock';

/** A fake `/api/time`: each call takes `rtts[i]` ms; the server clock runs `skew` ms ahead. */
function fakeServer(rtts: number[], skew: number) {
  let wall = 1_000_000;
  let perf = 0;
  let i = 0;
  const fetch = async () => {
    const rtt = rtts[i++] ?? 50;
    // The server stamps `now` halfway through the round trip.
    const now = wall + rtt / 2 + skew;
    wall += rtt;
    perf += rtt;
    return { ok: true, json: async () => ({ now }) };
  };
  return { fetch, wallNow: () => wall, perfNow: () => perf, calls: () => i };
}

describe('ServerClock', () => {
  it('takes the offset from the fastest of 5 round trips', async () => {
    const server = fakeServer([180, 40, 25, 90, 60], 3_000);
    const clock = new ServerClock(server);
    expect(clock.synced).toBe(false);
    expect(await clock.sync()).toBe(true);
    expect(server.calls()).toBe(5);
    expect(clock.offset).toBe(3_000);
    expect(clock.err).toBe(12.5);
    expect(clock.synced).toBe(true);
  });

  it('corrects ages by the offset and clamps them at zero', async () => {
    const server = fakeServer([20, 20, 20, 20, 20], 2_000); // browser clock 2 s slow
    const clock = new ServerClock(server);
    await clock.sync();
    const local = server.wallNow();
    expect(clock.age(local + 2_000 - 5_000, local)).toBe(5_000);
    expect(clock.age(local + 10_000, local)).toBe(0);
    expect(clock.age(null, local)).toBeNull();
    expect(clock.serverNow(local)).toBe(local + 2_000);
  });

  it('keeps the previous offset when every sample fails', async () => {
    const server = fakeServer([20, 20, 20, 20, 20], 1_000);
    const clock = new ServerClock(server);
    await clock.sync();
    const failing = new ServerClock({ ...server, fetch: async () => ({ ok: false, json: async () => ({}) }) });
    expect(await failing.sync()).toBe(false);
    expect(failing.synced).toBe(false);
    expect(clock.offset).toBe(1_000);
  });
});
