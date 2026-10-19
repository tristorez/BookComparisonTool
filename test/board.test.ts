import { describe, expect, it, vi } from 'vitest';
import type { BookChange, BookGame, BookStatus, QuoteSample } from '../src/books/types.js';
import { Board, type FeedHandle } from '../src/server/board.js';
import { BOOKS } from '../src/server/registry.js';
import type { BookId, MarketType, Side } from '../src/shared/domain.js';
import type { Delta, WireBestPick } from '../src/shared/wire.js';

const GK = '2026-10-25:PIT@NO';

function harness() {
  let clock = 1_000_000;
  const queue: (() => void)[] = [];
  const deltas: Delta[] = [];
  const board = new Board({ books: [BOOKS.draftkings, BOOKS.fanduel], staleGraceMs: 5_000, now: () => clock, defer: (fn) => queue.push(fn) });
  board.on('delta', (d) => deltas.push(d));
  const sources = new Map<string, { st: BookStatus; restart: ReturnType<typeof vi.fn> }>();
  const handles = new Map<string, FeedHandle>();
  for (const box of ['A', 'B']) {
    for (const book of ['draftkings', 'fanduel'] as BookId[]) {
      const src = { st: status(book, 'live', clock), restart: vi.fn() };
      sources.set(`${box}/${book}`, src);
      handles.set(`${box}/${book}`, board.addFeed(box, book, { getStatus: () => src.st, restart: src.restart }));
    }
  }
  const flush = () => {
    while (queue.length) queue.shift()!();
  };
  return {
    board,
    deltas,
    flush,
    h: (box: string, book: BookId) => handles.get(`${box}/${book}`)!,
    src: (box: string, book: BookId) => sources.get(`${box}/${book}`)!,
    advance(ms: number) {
      clock += ms;
      // Live feeds keep proving liveness.
      for (const s of sources.values()) if (s.st.state === 'live') s.st = { ...s.st, lastDataAt: clock };
    },
    get now() {
      return clock;
    },
    /** A full pregame board for one game at one book, as a change + samples. */
    seed(box: string, book: BookId, prices: Partial<Record<`${MarketType}.${Side}`, [number, number | null]>>, live = false) {
      const h = this.h(box, book);
      const samples = Object.entries(prices).map(([k, [american, line]]) => {
        const [market, side] = k.split('.') as [MarketType, Side];
        return sample(book, market, side, american, line, clock, { live });
      });
      h.samples(samples);
      h.change(change(book, [game(book, live)], samples));
    },
  };
}

function status(book: BookId, state: BookStatus['state'], lastDataAt: number | null): BookStatus {
  return { book, state, detail: null, lastDataAt, lastChangeAt: null, since: 0 };
}

function game(book: BookId, live = false): BookGame {
  return { book, gameKey: GK, bookEventId: `${book}-1`, away: 'PIT', home: 'NO', startTime: '2026-10-25T17:00:00.000Z', live };
}

function sample(book: BookId, market: MarketType, side: Side, american: number, line: number | null, at: number, o: Partial<QuoteSample> = {}): QuoteSample {
  return { book, gameKey: GK, market, side, channel: 'push', line, american, suspended: false, live: false, bookTime: at - 50, publishedAt: null, gatewayAt: null, receivedAt: at, applied: true, ...o };
}

function change(book: BookId, games: BookGame[], samples: QuoteSample[] = [], removed: { market: MarketType; side: Side }[] = []): BookChange {
  return {
    book,
    games,
    removedGames: [],
    quotes: samples.map((s) => ({ ...s, decimal: 0, gameKey: s.gameKey })),
    removedQuotes: removed.map((r) => ({ gameKey: GK, ...r })),
  };
}

const fullMarket = (ml: [number, number], spread: [number, number, number], total: [number, number, number]) => ({
  'moneyline.away': [ml[0], null] as [number, null],
  'moneyline.home': [ml[1], null] as [number, null],
  'spread.away': [spread[1], -spread[0]] as [number, number],
  'spread.home': [spread[2], spread[0]] as [number, number],
  'total.over': [total[1], total[0]] as [number, number],
  'total.under': [total[2], total[0]] as [number, number],
});

const best = (d: Delta[], market: MarketType, side: Side) =>
  d.flatMap((x) => x.bests ?? []).filter((b) => b.market === market && b.side === side).at(-1) as WireBestPick | undefined;

describe('Board', () => {
  it('coalesces everything from one event-loop turn into one delta with games, quotes and bests', () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.seed('A', 'fanduel', fullMarket([155, -175], [-3.5, -105, -115], [44.5, -112, -108]));
    t.flush();
    expect(t.deltas).toHaveLength(1);
    const d = t.deltas[0]!;
    expect(d.seq).toBe(1);
    expect(d.games![0]).toMatchObject({ key: GK, awayName: 'Pittsburgh Steelers', homeName: 'New Orleans Saints', books: ['draftkings', 'fanduel'] });
    expect(d.quotes).toHaveLength(12);
    expect(best(t.deltas, 'moneyline', 'away')).toMatchObject({ books: ['fanduel'], american: 155, rule: 'R1' });
    expect(best(t.deltas, 'spread', 'away')).toMatchObject({ books: ['fanduel'], american: -105, rule: 'R2' });
  });

  it("records the second box's copy as a duplicate (lag), not a change", () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.flush();
    t.advance(200);
    t.seed('B', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.flush();
    expect(t.deltas).toHaveLength(1);
  });

  it('marks a book stale only when every feed for it is stale, and drops it from best', () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.seed('A', 'fanduel', fullMarket([160, -180], [-3.5, -110, -110], [44.5, -110, -110]));
    t.board.tick();
    t.flush();
    expect(best(t.deltas, 'moneyline', 'away')!.books).toEqual(['fanduel']);

    // Connectors emit a status event when they go down; the board's grace period starts there.
    const goDown = (box: string) => {
      t.src(box, 'fanduel').st = status('fanduel', 'down', t.now);
      t.h(box, 'fanduel').status(t.src(box, 'fanduel').st);
    };
    goDown('A');
    t.advance(6_000);
    t.board.tick();
    t.flush();
    // Box B's FanDuel feed is still healthy, so FanDuel is not stale.
    expect(t.board.bookStatus('fanduel').stale).toBe(false);

    goDown('B');
    t.advance(6_000);
    t.board.tick();
    t.flush();
    expect(t.board.bookStatus('fanduel').stale).toBe(true);
    const b = best(t.deltas, 'moneyline', 'away')!;
    expect(b.books).toEqual(['draftkings']);
    expect(b.cause).toBe('eligibility');
  });

  it("drops a book from best as soon as the link of its last healthy feed goes down", () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.seed('B', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.seed('A', 'fanduel', fullMarket([140, -160], [-3.5, -115, -115], [44.5, -115, -115]));
    t.board.tick();
    t.flush();
    expect(best(t.deltas, 'moneyline', 'away')!.books).toEqual(['draftkings']);

    // DraftKings stops on Box A; Box B carries it.
    t.src('A', 'draftkings').st = status('draftkings', 'stopped', t.now);
    t.h('A', 'draftkings').status(t.src('A', 'draftkings').st);
    t.flush();
    expect(t.board.bookStatus('draftkings').stale).toBe(false);
    expect(best(t.deltas, 'moneyline', 'away')!.books).toEqual(['draftkings']);

    // Then Box B's link drops: no tick and no price change, only the link event.
    t.h('B', 'draftkings').setLinked(false);
    t.flush();
    expect(t.board.bookStatus('draftkings').stale).toBe(true);
    expect(best(t.deltas, 'moneyline', 'away')).toMatchObject({ books: ['fanduel'], american: 140, cause: 'eligibility' });
  });

  it('does not mark a book stale for a short reconnect (grace period)', () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.board.tick();
    for (const box of ['A', 'B']) t.src(box, 'draftkings').st = status('draftkings', 'down', t.now);
    t.advance(3_000);
    for (const box of ['A', 'B']) t.src(box, 'draftkings').st = status('draftkings', 'down', t.now - 3_000);
    t.board.tick();
    expect(t.board.bookStatus('draftkings').stale).toBe(false);
  });

  it('excludes suspended quotes and pregame leftovers on a live game from best', () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]), true);
    t.seed('A', 'fanduel', fullMarket([400, -500], [-3.5, -110, -110], [44.5, -110, -110]), false); // FD still pregame
    t.flush();
    expect(best(t.deltas, 'moneyline', 'away')!.books).toEqual(['draftkings']);
    const s = sample('draftkings', 'moneyline', 'away', 160, null, t.now + 10, { suspended: true, live: true });
    t.h('A', 'draftkings').samples([s]);
    t.flush();
    expect(best(t.deltas, 'moneyline', 'away')).toMatchObject({ none: true });
  });

  it('holds a mass removal for 15 s and cancels what is re-listed', () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.flush();
    const sides: { market: MarketType; side: Side }[] = [
      { market: 'moneyline', side: 'away' },
      { market: 'moneyline', side: 'home' },
      { market: 'spread', side: 'away' },
      { market: 'spread', side: 'home' },
      { market: 'total', side: 'over' },
      { market: 'total', side: 'under' },
    ];
    // Twelve removals needed to count as mass: duplicate the refs (a connector would list 12 quotes).
    t.h('A', 'draftkings').change(change('draftkings', [], [], [...sides, ...sides]));
    t.flush();
    expect(t.board.counters.massRemovalsHeld).toBe(1);
    expect(t.deltas.flatMap((d) => d.removedQuotes ?? [])).toEqual([]);
    t.advance(16_000);
    t.board.tick();
    t.flush();
    expect(t.deltas.flatMap((d) => d.removedQuotes ?? []).length).toBe(6);
  });

  it('freezes a feed that stops changing while its peer moves live prices, and restarts it', () => {
    const t = harness();
    t.seed('A', 'fanduel', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]), true);
    t.seed('B', 'fanduel', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]), true);
    t.flush();
    t.advance(91_000);
    for (let i = 0; i < 6; i++) {
      t.advance(1_000);
      t.h('A', 'fanduel').samples([sample('fanduel', 'moneyline', 'away', 150 + 5 * (i + 1), null, t.now, { live: true })]);
    }
    t.board.tick();
    t.flush();
    expect(t.board.counters.watchdogFreezes).toBe(1);
    expect(t.src('B', 'fanduel').restart).toHaveBeenCalledOnce();
    expect(t.board.health().feeds.find((f) => f.feed === 'B' && f.book === 'fanduel')!.frozen).toBe(true);
  });

  it('flags a game suspect when books disagree beyond plausibility, and drops it from best', () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([-300, 250], [-7.5, -110, -110], [44.5, -110, -110]));
    t.seed('A', 'fanduel', fullMarket([250, -300], [-7.5, -110, -110], [44.5, -110, -110])); // teams swapped?
    t.flush();
    expect(t.deltas.flatMap((d) => d.games ?? []).at(-1)!.suspect).toBe(true);
    expect(best(t.deltas, 'moneyline', 'away')).toMatchObject({ none: true });
  });

  it('serves resume ranges and refuses ones it no longer (or not yet) has', () => {
    const t = harness();
    t.seed('A', 'draftkings', fullMarket([150, -170], [-3.5, -110, -110], [44.5, -110, -110]));
    t.flush();
    t.h('A', 'draftkings').samples([sample('draftkings', 'moneyline', 'away', 155, null, t.now + 5)]);
    t.flush();
    expect(t.board.since(0)!.map((d) => d.seq)).toEqual([1, 2]);
    expect(t.board.since(2)).toEqual([]);
    expect(t.board.since(3)).toBeNull();
    expect(t.board.snapshot().seq).toBe(2);
  });

  it('drops invalid prices and never throws back into a connector', () => {
    const t = harness();
    t.h('A', 'draftkings').samples([sample('draftkings', 'moneyline', 'away', 50, null, t.now)]);
    expect(t.board.counters.invalidQuotes).toBe(1);
    expect(() => t.h('A', 'draftkings').change({ book: 'draftkings' } as unknown as BookChange)).not.toThrow();
    expect(t.board.counters.aggregatorErrors).toBe(1);
  });
});
