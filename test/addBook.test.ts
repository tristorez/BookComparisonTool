import { afterEach, describe, expect, it, vi } from 'vitest';
import { Board } from '../src/server/board.js';
import { ConfigError, loadConfig } from '../src/server/config.js';
import { FakeConnector } from '../src/server/fake.js';
import { BOOKS, createConnector, regionOf, type BookSpec } from '../src/server/registry.js';
import { BOOK_IDS, type BookId } from '../src/shared/domain.js';
import type { WireBestPick, WireQuote } from '../src/shared/wire.js';

/**
 * Adding a book is a connector, its id in BOOK_IDS and one registry entry (README "Adding a book"). These
 * pin what makes that true: the registry is the only list of books, and nothing downstream assumes two.
 */
describe('adding a book', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has one registry entry per id, each building its own connector, with unique codes and colors', () => {
    const real = loadConfig({});
    const fake = loadConfig({ BOOKS: 'fake' });
    for (const id of BOOK_IDS) {
      expect(BOOKS[id].id).toBe(id);
      // Constructing a connector opens nothing; only start() does.
      expect(createConnector(id, real).book).toBe(id);
      const synthetic = createConnector(id, fake);
      expect(synthetic).toBeInstanceOf(FakeConnector);
      expect(synthetic.book).toBe(id);
    }
    const entries = Object.values(BOOKS);
    expect(entries).toHaveLength(BOOK_IDS.length);
    // `short` names the book's env vars (FAKE_MODE_DK) and its badge; the color tells books apart on screen.
    expect(new Set(entries.map((b) => b.short)).size).toBe(entries.length);
    expect(new Set(entries.map((b) => b.color)).size).toBe(entries.length);
  });

  it('reads every per-book setting by the registry short code, not a hardcoded list', () => {
    const cfg = loadConfig({ BOOKS: 'fake', FAKE_MODE_FD: 'freeze', STALE_AFTER_DK_MS: '9000' });
    expect(cfg.books).toEqual([...BOOK_IDS]);
    expect(cfg.fake?.modes).toEqual({ fanduel: 'freeze' });
    expect(cfg.staleAfterMs).toEqual({ draftkings: 9_000 });
    expect(() => loadConfig({ FAKE_MODE_DK: 'sideways' })).toThrow(/FAKE_MODE_DK must be one of/);
    expect(() => loadConfig({ BOOKS: 'draftkings,caesars' })).toThrow(ConfigError);
    expect(regionOf('fanduel', loadConfig({ FD_REGION: 'pa' }))).toBe('PA');
    expect(regionOf('fanduel', cfg)).toBeUndefined();
  });

  it('carries a third book through the board, best price and snapshot with no other change', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 25, 17, 0, 0) });
    const caesars: BookSpec = { ...BOOKS.draftkings, id: 'caesars' as BookId, name: 'Caesars', short: 'CZ', color: '#c4a35a' };
    const specs = [BOOKS.draftkings, BOOKS.fanduel, caesars];
    const queue: (() => void)[] = [];
    const board = new Board({ books: specs, staleGraceMs: 5_000, defer: (fn) => queue.push(fn) });
    const connectors = specs.map((spec) => {
      const c = new FakeConnector(spec, { seed: 3, ratePerSec: 20 });
      const feed = board.addFeed('A', spec.id, { getStatus: () => c.status });
      c.on('change', feed.change);
      c.on('sample', feed.samples);
      c.on('status', feed.status);
      return c;
    });
    await Promise.all(connectors.map((c) => c.start()));
    for (let s = 0; s < 10; s++) {
      await vi.advanceTimersByTimeAsync(1_000);
      board.tick();
      while (queue.length) queue.shift()!();
    }

    const snap = board.snapshot();
    expect(snap.books.map((b) => b.short)).toEqual(['DK', 'FD', 'CZ']);
    expect(snap.status.map((s) => [s.book, s.state, s.stale])).toEqual([
      ['draftkings', 'live', false],
      ['fanduel', 'live', false],
      ['caesars', 'live', false],
    ]);
    const prices = (book: BookId) =>
      snap.quotes
        .filter((q) => q.book === book)
        .map((q: WireQuote) => `${q.game}|${q.market}|${q.side}|${q.line}|${q.american}`)
        .sort();
    for (const other of ['draftkings', 'fanduel'] as const) {
      expect(prices(caesars.id)).toHaveLength(prices(other).length);
      expect(prices(caesars.id)).not.toEqual(prices(other)); // its own prices, not a copy of another book's
    }
    const picks = snap.bests.filter((b): b is WireBestPick => b.none !== true);
    expect(picks.some((p) => p.books.includes(caesars.id))).toBe(true);
    await Promise.all(connectors.map((c) => c.stop()));
  });
});
