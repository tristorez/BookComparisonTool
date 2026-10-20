import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireGame } from '@shared/wire';
import { BOOKS, GAME, delta, game, manualStore, none, pick, quote, snapshot, status } from '../test/fixtures';
import { cellKey, quoteKey } from './shared';
import { OddsStore, TOPICS } from './store';

const DK_KEY = quoteKey('draftkings', GAME, 'spread', 'home');
const CELL = cellKey(GAME, 'spread', 'home');

afterEach(() => {
  vi.useRealTimers();
});

describe('OddsStore notifications', () => {
  it('notifies once per frame for a burst of deltas, and only the touched topics', () => {
    const frames: Array<() => void> = [];
    const store = new OddsStore({ schedule: (f) => frames.push(f) });
    store.applySnapshot(snapshot({ quotes: [quote('draftkings')] }));
    frames.splice(0).forEach((f) => f());

    const onQuote = vi.fn();
    const onOther = vi.fn();
    store.subscribe(TOPICS.quote(DK_KEY), onQuote);
    store.subscribe(TOPICS.quote(quoteKey('fanduel', GAME, 'spread', 'home')), onOther);
    for (let seq = 11; seq <= 15; seq++) store.applyDelta(delta(seq, { quotes: [quote('draftkings', { american: -100 - seq })] }));

    expect(onQuote).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.splice(0).forEach((f) => f());
    expect(onQuote).toHaveBeenCalledTimes(1);
    expect(onOther).not.toHaveBeenCalled();
    expect(store.getQuoteByKey(DK_KEY).quote?.american).toBe(-115);
  });

  it('returns cached references until the content changes', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings')], bests: [pick()] }));
    const cell = store.getCellByKey(CELL);
    const games = store.getGames();
    const elig = store.getEligibility();
    expect(store.getCellByKey(CELL)).toBe(cell);
    expect(store.getGames()).toBe(games);
    expect(store.getCell(GAME, 'total', 'over')).toBe(store.getCell(GAME, 'total', 'under')); // shared empty

    store.applyDelta(delta(11, { quotes: [quote('draftkings', { american: -105 })] }));
    expect(store.getCellByKey(CELL)).toBe(cell); // quote changes don't touch the best cell
    expect(store.getGames()).toBe(games); // nor the game list
    expect(store.getEligibility()).toBe(elig);

    store.applyDelta(delta(12, { bests: [pick({ american: -105 })] }));
    expect(store.getCellByKey(CELL)).not.toBe(cell);
  });

  it('keeps the book registry across identical snapshots, and replaces it when a region changes', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ books: BOOKS.map((b) => ({ ...b, region: 'NJ' })) }));
    const books = store.getBooks();
    store.applySnapshot(snapshot({ books: BOOKS.map((b) => ({ ...b, region: 'NJ' })) }));
    expect(store.getBooks()).toBe(books);
    // A board restarted for another jurisdiction: the footer's "NJ lines" note must follow.
    store.applySnapshot(snapshot({ books: BOOKS.map((b) => ({ ...b, region: 'PA' })) }));
    expect(store.getBooks().map((b) => b.region)).toEqual(['PA', 'PA']);
  });

  it('runs afterFlush callbacks after listeners, in the same frame', () => {
    const store = manualStore();
    const order: string[] = [];
    store.subscribe(TOPICS.status, () => order.push('listener'));
    store.applyStatus([status('draftkings')]);
    store.afterFlush(() => order.push('after'));
    store.flush();
    expect(order).toEqual(['listener', 'after']);
  });
});

describe('OddsStore games', () => {
  const g = (key: string, start: string, over: Partial<WireGame> = {}) => game({ key, start, ...over });

  it('sorts live first, then by kickoff, grouped by ET date, hiding games without quotes', () => {
    const store = manualStore();
    const games = [
      g('2026-10-25:A@B', '2026-10-25T20:25:00Z'),
      g('2026-10-25:C@D', '2026-10-25T17:00:00Z'),
      g('2026-10-26:E@F', '2026-10-27T00:15:00Z'), // Monday 8:15 pm ET, Tuesday in UTC
      g('2026-10-25:G@H', '2026-10-25T17:00:00Z', { live: true }),
      g('2026-10-25:I@J', '2026-10-25T17:00:00Z'), // no quotes
    ];
    const quotes = games.filter((x) => x.key !== '2026-10-25:I@J').map((x) => quote('draftkings', { game: x.key }));
    store.applySnapshot(snapshot({ games, quotes }));
    const groups = store.getGames();
    expect(groups.map((x) => x.id)).toEqual(['live', '2026-10-25', '2026-10-26']);
    expect(groups.map((x) => x.label)).toEqual(['Live', 'Sunday, Oct 25', 'Monday, Oct 26']);
    expect(groups.map((x) => x.games.map((y) => y.key))).toEqual([
      ['2026-10-25:G@H'],
      ['2026-10-25:C@D', '2026-10-25:A@B'],
      ['2026-10-26:E@F'],
    ]);
  });

  it('shows a game when it gets its first quote and hides it when the last one goes', () => {
    const store = manualStore();
    store.applySnapshot(snapshot());
    expect(store.getGames()).toHaveLength(0);
    store.applyDelta(delta(11, { quotes: [quote('draftkings')] }));
    expect(store.getGames()[0]?.games.map((x) => x.key)).toEqual([GAME]);
    store.applyDelta(delta(12, { removedQuotes: [DK_KEY] }));
    expect(store.getGames()).toHaveLength(0);
  });

  it('a removed game takes its quotes and bests with it', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings')], bests: [pick()] }));
    store.applyDelta(delta(11, { removedGames: [GAME] }));
    expect(store.getGames()).toHaveLength(0);
    expect(store.getQuoteByKey(DK_KEY).quote).toBeUndefined();
    expect(store.getCellByKey(CELL).best).toBeUndefined();
  });
});

describe('OddsStore moves (flash + previous price)', () => {
  const moved = (american: number, prevAmerican: number, at: number, over = {}) =>
    quote('draftkings', { american, prev: { american: prevAmerican, line: -3, at }, ...over });

  it('records a live quote move with its direction for the bettor', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings')] }));
    store.applyDelta(delta(11, { quotes: [moved(-105, -110, 5_000)] }), { live: true });
    const first = store.getQuoteByKey(DK_KEY).move;
    expect(first).toMatchObject({ dir: 'up', prevAmerican: -110, prevLine: -3 });

    store.applyDelta(delta(12, { quotes: [moved(-115, -105, 6_000)] }), { live: true });
    const second = store.getQuoteByKey(DK_KEY).move;
    expect(second).toMatchObject({ dir: 'down', prevAmerican: -105 });
    expect(second!.n).toBeGreaterThan(first!.n);

    // A suspension toggle is not a move: the record (and its 5 s previous price) stays as is.
    store.applyDelta(delta(13, { quotes: [moved(-115, -105, 6_000, { suspended: true })] }), { live: true });
    expect(store.getQuoteByKey(DK_KEY).move).toBe(second);
  });

  it('records nothing for replayed or hidden-tab deltas, and drops a now-wrong previous price', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings')] }));
    store.applyDelta(delta(11, { quotes: [moved(-105, -110, 5_000)] }), { live: true });
    store.applyDelta(delta(12, { quotes: [moved(-120, -105, 6_000)] }), { live: false });
    expect(store.getQuoteByKey(DK_KEY).move).toBeUndefined();
    expect(store.getQuoteByKey(DK_KEY).quote?.american).toBe(-120);
  });

  it('a snapshot clears every move, even if its quotes carry a recent prev', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings')], bests: [pick()] }));
    store.applyDelta(delta(11, { quotes: [moved(-105, -110, 5_000)], bests: [pick({ american: -105 })] }), { live: true });
    expect(store.getQuoteByKey(DK_KEY).move).toBeDefined();
    expect(store.getCellByKey(CELL).move).toBeDefined();
    store.applySnapshot(snapshot({ seq: 20, quotes: [moved(-102, -105, 9_000)], bests: [pick({ american: -102 })] }));
    expect(store.getQuoteByKey(DK_KEY).move).toBeUndefined();
    expect(store.getCellByKey(CELL).move).toBeUndefined();
  });

  it('best cell: moves only on cause "price" when the displayed value changes', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ bests: [pick()] }));
    store.applyDelta(delta(11, { bests: [pick({ american: -120, cause: 'eligibility' })] }), { live: true });
    expect(store.getCellByKey(CELL).move).toBeUndefined();

    store.applyDelta(delta(12, { bests: [pick({ american: -105, cause: 'price' })] }), { live: true });
    const m = store.getCellByKey(CELL).move;
    expect(m).toMatchObject({ dir: 'up', prevAmerican: -120 });

    // A tie forming at the same price is not a move of the displayed value.
    store.applyDelta(delta(13, { bests: [pick({ american: -105, books: ['draftkings', 'fanduel'], rule: 'R5' })] }), { live: true });
    expect(store.getCellByKey(CELL).move).toBe(m);

    // Going to "none" is never a move, and drops the previous price.
    store.applyDelta(delta(14, { bests: [none({ cause: 'price' })] }), { live: true });
    expect(store.getCellByKey(CELL).move).toBeUndefined();
  });

  it('best cell: a line move decides direction before price', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ bests: [pick({ line: -3.5, american: +100 })] }));
    store.applyDelta(delta(11, { bests: [pick({ line: -3, american: -120 })] }), { live: true });
    expect(store.getCellByKey(CELL).move?.dir).toBe('up'); // laying fewer points
  });
});

describe('OddsStore eligibility and connection', () => {
  it('tracks stale books from status', () => {
    const store = manualStore();
    store.applySnapshot(snapshot());
    expect([...store.getEligibility().stale]).toEqual([]);
    store.applyDelta(delta(11, { status: [status('fanduel', { stale: true, state: 'down' })] }));
    expect([...store.getEligibility().stale]).toEqual(['fanduel']);
  });

  it('marks the whole board disconnected only after the grace period', () => {
    vi.useFakeTimers();
    const store = new OddsStore({ schedule: () => {}, disconnectGraceMs: 2_000 });
    store.applySnapshot(snapshot());
    store.setConnection('open', 1);
    store.setConnection('reconnecting', 1);
    expect(store.getConnection().state).toBe('reconnecting');
    expect(store.getEligibility().disconnected).toBe(false);
    vi.advanceTimersByTime(2_000);
    expect(store.getEligibility().disconnected).toBe(true);
    store.setConnection('open', 5);
    expect(store.getEligibility().disconnected).toBe(false);

    // A quick resume never marks the board stale.
    store.setConnection('reconnecting', 5);
    vi.advanceTimersByTime(500);
    store.setConnection('open', 6);
    vi.advanceTimersByTime(5_000);
    expect(store.getEligibility().disconnected).toBe(false);
  });
});
