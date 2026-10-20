import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookChange, Quote } from '../src/books/types.js';
import { FakeConnector } from '../src/server/fake.js';
import { BOOKS } from '../src/server/registry.js';

const price = (q: Quote) => `${q.gameKey}|${q.market}|${q.side}|${q.line}|${q.american}`;

describe('FakeConnector', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is one book in every process: a feed started later holds the same prices, then reports the same changes at the same book times', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 25, 17, 0, 0) });
    for (const spec of [BOOKS.draftkings, BOOKS.fanduel]) {
      const early = new FakeConnector(spec, { seed: 5, ratePerSec: 20 });
      const late = new FakeConnector(spec, { seed: 5, ratePerSec: 20 });
      await early.start();
      await vi.advanceTimersByTimeAsync(5_000);
      await late.start();
      await vi.advanceTimersByTimeAsync(320); // late's snapshot lands at +300 ms
      expect(late.snapshot().quotes.map(price).sort()).toEqual(early.snapshot().quotes.map(price).sort());

      const reported = (c: FakeConnector) => {
        const out: string[] = [];
        c.on('change', (ch: BookChange) => out.push(...ch.quotes.map((q) => `${price(q)}|${q.channel}|${q.bookTime}`)));
        return out;
      };
      const [a, b] = [reported(early), reported(late)];
      await vi.advanceTimersByTimeAsync(5_000);
      expect(a.length).toBeGreaterThan(50);
      expect(b).toEqual(a);
      await Promise.all([early.stop(), late.stop()]);
    }
  });
});
