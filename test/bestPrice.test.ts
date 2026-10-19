import { describe, expect, it } from 'vitest';
import type { BookId } from '../src/shared/domain.js';
import { bestOf, bookAnchor, compareOdds, getFairProbability, medianStrategy, rankOffers, type GameOffers, type Offer } from '../src/shared/bestPrice.js';
import { createPushTable, NFL_PUSH_TABLE } from '../src/shared/pushTable.js';
import data from '../src/shared/data/nfl-push-table.json' with { type: 'json' };

const DK = 'draftkings' as const;
const FD = 'fanduel' as const;
const o = (book: BookId, side: Offer['side'], line: number | null, american: number): Offer => ({ book, side, line, american });
/** The brief's example, with a fixed push rate at 3 so the arithmetic is checkable by hand. */
const table9 = createPushTable([{ k: 3, p: 0.09 }], 0);

const briefGame: GameOffers = {
  live: false,
  books: {
    draftkings: { spread: { home: o(DK, 'home', -3, -110), away: o(DK, 'away', 3, -110) } },
    fanduel: { spread: { home: o(FD, 'home', -3.5, 100), away: o(FD, 'away', 3.5, -120) } },
  },
};

describe('push table', () => {
  it('ranks the classic NFL key numbers first', () => {
    const top = [...data.table].filter((r) => r.k > 0).sort((a, b) => b.p - a.p).slice(0, 4).map((r) => r.k);
    expect(top).toEqual([3, 7, 10, 14]);
    for (const r of data.table) expect(r.p).toBeLessThanOrEqual(0.12);
  });
  it('has no mass on half points', () => {
    expect(NFL_PUSH_TABLE.pm(3.5)).toBe(0);
    expect(NFL_PUSH_TABLE.pm(-3)).toBe(NFL_PUSH_TABLE.pm(3));
  });
});

describe('anchor (consensus no-vig)', () => {
  it("moves each book's no-vig P(cover) to a common half-point and averages", () => {
    const dk = bookAnchor(o(DK, 'home', -3, -110), o(DK, 'away', 3, -110), table9)!;
    const fd = bookAnchor(o(FD, 'home', -3.5, 100), o(FD, 'away', 3.5, -120), table9)!;
    expect(dk.x).toBe(3.5);
    expect(dk.pAbove).toBeCloseTo(0.455, 3); // 0.5 × (1 − 0.09)
    expect(fd.x).toBe(3.5);
    expect(fd.pAbove).toBeCloseTo(0.4783, 3);
    const anchor = getFairProbability(briefGame, 'spread', { table: table9 })!;
    expect(anchor.pAbove).toBeCloseTo(0.4666, 3);
    expect(anchor.books).toEqual([DK, FD]);
  });

  it('skips a book whose two sides are mid line-move, and anchors on one book alone', () => {
    const game: GameOffers = {
      live: false,
      books: {
        draftkings: { spread: { home: o(DK, 'home', -3.5, -110), away: o(DK, 'away', 3, -110) } },
        fanduel: briefGame.books.fanduel,
      },
    };
    expect(getFairProbability(game, 'spread', { table: table9 })!.books).toEqual([FD]);
  });

  it('applies to pregame spreads only', () => {
    expect(getFairProbability({ ...briefGame, live: true }, 'spread')).toBeNull();
    expect(getFairProbability(briefGame, 'total')).toBeNull();
  });

  it('supports a pluggable combination strategy', () => {
    expect(getFairProbability(briefGame, 'spread', { table: table9, strategy: medianStrategy })!.pAbove).toBeCloseTo(0.4666, 3);
  });
});

describe('R3: pregame spreads on different lines (estimated return)', () => {
  it('gives the favorite to DK -3 -110 and the underdog to FD +3.5 -120 (the brief example)', () => {
    const fav = bestOf(briefGame, 'spread', 'home', { table: table9 })!;
    expect(fav.books).toEqual([DK]);
    expect(fav.rule).toBe('R3');
    expect(fav.exact).toBe(false);
    expect(fav.reason).toContain('0.981 vs 0.933');
    expect(fav.reason).toContain('3 lands 9.0%');

    const dog = bestOf(briefGame, 'spread', 'away', { table: table9 })!;
    expect(dog.books).toEqual([FD]);
    expect(dog.rule).toBe('R3');
    expect(dog.reason).toContain('0.978 vs 0.936');
  });

  it('notes when the winner has both the better line and the better price', () => {
    const game: GameOffers = {
      live: false,
      books: {
        draftkings: { spread: { home: o(DK, 'home', -3, -105), away: o(DK, 'away', 3, -115) } },
        fanduel: { spread: { home: o(FD, 'home', -3.5, -110), away: o(FD, 'away', 3.5, -110) } },
      },
    };
    const r = bestOf(game, 'spread', 'home')!;
    expect(r.books).toEqual([DK]);
    expect(r.exact).toBe(false);
    expect(r.reason).toContain('better line and price');
  });

  it('handles lines that cross pick-em without NaN', () => {
    const game: GameOffers = {
      live: false,
      books: {
        draftkings: { spread: { home: o(DK, 'home', -1, -110), away: o(DK, 'away', 1, -110) } },
        fanduel: { spread: { home: o(FD, 'home', 1, -105), away: o(FD, 'away', -1, -115) } },
      },
    };
    for (const side of ['home', 'away'] as const) {
      const r = bestOf(game, 'spread', side)!;
      expect(r.rule).toBe('R3');
      expect(r.reason).not.toContain('NaN');
    }
  });
});

describe('R1, R2, R5: direct price comparisons', () => {
  it('R1 moneyline: higher payout, exact', () => {
    const r = rankOffers([o(DK, 'home', null, 150), o(FD, 'home', null, 145)], { market: 'moneyline', live: false, anchor: null })!;
    expect(r).toMatchObject({ books: [DK], rule: 'R1', exact: true });
  });

  it('R2 same line: better price, exact', () => {
    const r = rankOffers([o(DK, 'home', -3, -110), o(FD, 'home', -3, -105)], { market: 'spread', live: false, anchor: null })!;
    expect(r).toMatchObject({ books: [FD], rule: 'R2', exact: true });
  });

  it('R5 equal terms: a tie listing every book', () => {
    const r = rankOffers([o(DK, 'over', 47.5, -110), o(FD, 'over', 47.5, -110)], { market: 'total', live: false, anchor: null })!;
    expect(r).toMatchObject({ books: [DK, FD], rule: 'R5', exact: true });
  });

  it('compares displayed prices only, so differing feed decimals cannot split a tie', () => {
    // Offers carry no decimal at all: -110 is -110 whatever a feed's internal precision says.
    const c = compareOdds(o(DK, 'home', null, -110), o(FD, 'home', null, -110), { market: 'moneyline', live: false, anchor: null });
    expect(c.pick).toBe('tie');
  });
});

describe('R4: different lines where no model applies (line first)', () => {
  it('totals: the over takes the lower total, the under the higher', () => {
    const over = rankOffers([o(DK, 'over', 47.5, -110), o(FD, 'over', 48, -105)], { market: 'total', live: false, anchor: null })!;
    expect(over).toMatchObject({ books: [DK], rule: 'R4', exact: false });
    const under = rankOffers([o(DK, 'under', 47.5, -105), o(FD, 'under', 48, -115)], { market: 'total', live: false, anchor: null })!;
    expect(under).toMatchObject({ books: [FD], rule: 'R4', exact: false });
  });

  it('live spreads skip the pregame model', () => {
    const r = bestOf({ ...briefGame, live: true }, 'spread', 'home')!;
    expect(r).toMatchObject({ books: [DK], rule: 'R4', exact: false });
  });

  it('pregame spreads with no usable anchor fall back to line first', () => {
    const game: GameOffers = {
      live: false,
      books: {
        draftkings: { spread: { home: o(DK, 'home', -3, -110) } },
        fanduel: { spread: { home: o(FD, 'home', -3.5, 100) } },
      },
    };
    expect(bestOf(game, 'spread', 'home')).toMatchObject({ books: [DK], rule: 'R4' });
  });
});

describe('exact over a set of offers', () => {
  it('is false once the winner beat any offer on different terms', () => {
    const other = 'caesars' as BookId;
    const r = rankOffers(
      [o(DK, 'over', 47.5, -110), o(FD, 'over', 47.5, -110), o(other, 'over', 48, 100)],
      { market: 'total', live: false, anchor: null },
    )!;
    expect(r.books).toEqual([DK, FD]);
    expect(r.rule).toBe('R4');
    expect(r.exact).toBe(false);
  });

  it('ignores invalid prices', () => {
    const r = rankOffers([o(DK, 'home', null, -50), o(FD, 'home', null, -120)], { market: 'moneyline', live: false, anchor: null })!;
    expect(r.books).toEqual([FD]);
  });
});
