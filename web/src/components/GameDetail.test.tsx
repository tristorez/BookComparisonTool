import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { StoreContext, type OddsStore } from '../lib/store';
import { delta, GAME, manualStore, pick, quote, snapshot } from '../test/fixtures';
import { GameDetail } from './GameDetail';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const withStore = (store: OddsStore, ui: ReactNode) => render(<StoreContext value={store}>{ui}</StoreContext>);

/** PIT@NO with both books on every market; the spreads are half a point apart (R3 picks). */
function fullStore(): OddsStore {
  const store = manualStore();
  store.applySnapshot(
    snapshot({
      quotes: [
        quote('draftkings', { side: 'away', line: 3, american: -115 }),
        quote('draftkings', { side: 'home', line: -3, american: -105 }),
        quote('fanduel', { side: 'away', line: 2.5, american: -102 }),
        quote('fanduel', { side: 'home', line: -2.5, american: -120 }),
        quote('draftkings', { market: 'total', side: 'over', line: 44.5, american: -110 }),
        quote('draftkings', { market: 'total', side: 'under', line: 44.5, american: -110 }),
        quote('fanduel', { market: 'total', side: 'over', line: 44.5, american: -112 }),
        quote('fanduel', { market: 'total', side: 'under', line: 44.5, american: -108 }),
        quote('draftkings', { market: 'moneyline', side: 'away', line: null, american: 150 }),
        quote('draftkings', { market: 'moneyline', side: 'home', line: null, american: -170 }),
        quote('fanduel', { market: 'moneyline', side: 'away', line: null, american: 155 }),
        quote('fanduel', { market: 'moneyline', side: 'home', line: null, american: -175 }),
      ],
      bests: [
        pick({ side: 'away', books: ['draftkings'], line: 3, american: -115, exact: false, rule: 'R3', reason: 'Est. return per $1: 0.975 vs 0.935' }),
        pick({ side: 'home', books: ['fanduel'], line: -2.5, american: -120, exact: false, rule: 'R3', reason: 'Est. return per $1: 0.967 vs 0.943' }),
        pick({ market: 'total', side: 'over', books: ['draftkings'], line: 44.5, american: -110 }),
        pick({ market: 'total', side: 'under', books: ['fanduel'], line: 44.5, american: -108 }),
        pick({ market: 'moneyline', side: 'away', books: ['fanduel'], line: null, american: 155, rule: 'R1' }),
        pick({ market: 'moneyline', side: 'home', books: ['draftkings'], line: null, american: -170, rule: 'R1' }),
      ],
    }),
  );
  return store;
}

const section = (name: string) => screen.getByRole('region', { name });
/** The text of one book's price for one side. */
const price = (el: HTMLElement, book: string, side: string) => el.querySelector(`tr[data-book="${book}"] td[data-side="${side}"] [data-cell]`)!.textContent;
const best = (el: HTMLElement, side: string) => el.querySelector(`tr[data-best-row] td[data-side="${side}"] [data-cell="best"]`)!;
const hold = (el: HTMLElement, book: string) => el.querySelector(`[data-hold="${book}"]`)!.textContent;
/** Visible labels: a tooltip's text sits in the DOM beside its trigger, so it is left out. */
const texts = (els: HTMLElement[]) =>
  els.map((e) => {
    const copy = e.cloneNode(true) as HTMLElement;
    for (const tip of copy.querySelectorAll('[role="tooltip"]')) tip.remove();
    return copy.textContent;
  });

describe('GameDetail', () => {
  it('lists the sportsbooks down the left with both sides of each market, stars the best price, and shows each hold', () => {
    withStore(fullStore(), <GameDetail gameKey={GAME} onBack={() => {}} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Pittsburgh Steelers at New Orleans Saints');
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['Spread', 'Total', 'Moneyline']);

    const spread = section('Spread');
    expect(texts(within(spread).getAllByRole('columnheader'))).toEqual(['Sportsbook', 'PIT Steelers', 'NO Saints', 'Hold']);
    expect(texts(within(spread).getAllByRole('rowheader'))).toEqual(['DraftKings', 'FanDuel', 'Best']);
    expect(price(spread, 'draftkings', 'away')).toBe('+3 −115★');
    expect(price(spread, 'fanduel', 'away')).toBe('+2.5 −102');
    expect(price(spread, 'draftkings', 'home')).toBe('−3 −105');
    expect(price(spread, 'fanduel', 'home')).toBe('−2.5 −120★');
    // The Best row names the book and how the pick was made, without repeating the other books.
    expect(best(spread, 'away').querySelector('[data-book-names]')!.textContent).toBe('Best at DK');
    expect(best(spread, 'away').querySelector('[data-method]')!.textContent).toBe('est.');
    expect(best(spread, 'home').querySelector('[data-book-names]')!.textContent).toBe('Best at FD');
    expect(spread.querySelector('[data-other]')).toBeNull();
    expect(hold(spread, 'draftkings')).toBe('4.7%');
    expect(hold(spread, 'fanduel')).toBe('5.0%');
    expect(texts([...spread.querySelectorAll<HTMLElement>('[data-note]')])).toEqual([
      'est. PIT: Est. return per $1: 0.975 vs 0.935',
      'est. NO: Est. return per $1: 0.967 vs 0.943',
    ]);

    const total = section('Total');
    expect(texts(within(total).getAllByRole('columnheader'))).toEqual(['Sportsbook', 'Over', 'Under', 'Hold']);
    expect(price(total, 'fanduel', 'under')).toBe('u44.5 −108★');
    expect(hold(total, 'draftkings')).toBe('4.8%');
    expect(total.querySelector('[data-note]')).toBeNull();

    const ml = section('Moneyline');
    expect(price(ml, 'fanduel', 'away')).toBe('+155★');
    expect(hold(ml, 'draftkings')).toBe('3.0%');
    expect(hold(ml, 'fanduel')).toBe('2.9%');
  });

  it('grows downward: another sportsbook in the registry is another row', () => {
    const store = fullStore();
    const betmgm = { id: 'betmgm', name: 'BetMGM', short: 'MGM', color: '#c0a062' } as never;
    act(() => {
      store.applySnapshot(snapshot({ books: [...snapshot().books, betmgm], quotes: [quote('draftkings')], bests: [pick()] }));
    });
    withStore(store, <GameDetail gameKey={GAME} onBack={() => {}} />);
    const spread = section('Spread');
    expect(texts(within(spread).getAllByRole('rowheader'))).toEqual(['DraftKings', 'FanDuel', 'BetMGM', 'Best']);
    expect(within(spread).getAllByRole('columnheader')).toHaveLength(4);
    expect(screen.getByText(/3 sportsbooks compared/)).toBeTruthy();
  });

  it('updates live: a moved price flashes in its own book\'s row', () => {
    const store = fullStore();
    withStore(store, <GameDetail gameKey={GAME} onBack={() => {}} />);
    act(() => {
      store.applyDelta(delta(11, { quotes: [quote('draftkings', { side: 'home', line: -3, american: -102, prev: { american: -105, line: -3, at: Date.now() } })] }), { live: true });
      store.flush();
    });
    const spread = section('Spread');
    expect(price(spread, 'draftkings', 'home')).toContain('−3 −102');
    expect(spread.querySelector('tr[data-book="draftkings"] td[data-side="home"] [data-flash="up"]')).not.toBeNull();
    expect(spread.querySelector('tr[data-book="fanduel"] [data-flash]')).toBeNull();
  });

  it('says it is connecting, then that the game left the board', () => {
    const store = manualStore();
    withStore(store, <GameDetail gameKey={GAME} onBack={() => {}} />);
    expect(screen.getByText('Connecting to live odds…')).toBeTruthy();
    act(() => {
      store.applySnapshot(snapshot({ games: [] }));
      store.flush();
    });
    expect(screen.getByText('This game is no longer on the board.')).toBeTruthy();
  });
});

describe('Opening a game from the board', () => {
  let scrollTo: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Compare opens the comparison at the top; All games goes back to where the board was', async () => {
    const { container } = withStore(fullStore(), <App />);
    Object.defineProperty(window, 'scrollY', { value: 640, configurable: true });
    const card = screen.getByRole('article', { name: 'Pittsburgh Steelers at New Orleans Saints' });
    fireEvent.click(within(card).getByRole('link', { name: /Compare every book/ }));

    expect(new URLSearchParams(window.location.search).get('game')).toBe(GAME);
    expect(container.querySelector(`[data-detail="${GAME}"]`)).not.toBeNull();
    expect(screen.queryByRole('tab', { name: 'Best Price' })).toBeNull(); // every book is listed anyway
    expect(document.title).toBe('PIT @ NO · NFL Odds Board');
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);

    fireEvent.click(screen.getByRole('link', { name: 'All games' })); // history.back(), like the browser's Back
    await waitFor(() => expect(container.querySelector('[data-detail]')).toBeNull());
    expect(new URLSearchParams(window.location.search).get('game')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Best Price' })).toBeTruthy();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  });

  it('a click anywhere on the card opens it, except on a tooltip inside it', () => {
    const { container } = withStore(fullStore(), <App />);
    const card = screen.getByRole('article', { name: 'Pittsburgh Steelers at New Orleans Saints' });
    fireEvent.click(card.querySelector('[data-method]')!); // the "est." tooltip
    expect(container.querySelector('[data-detail]')).toBeNull();
    fireEvent.click(within(card).getByText('PIT'));
    expect(container.querySelector(`[data-detail="${GAME}"]`)).not.toBeNull();
  });

  it('a link straight to a game opens it, and All games returns to the board', () => {
    window.history.replaceState(null, '', `/?view=fanduel&game=${encodeURIComponent(GAME)}`);
    const { container } = withStore(fullStore(), <App />);
    expect(container.querySelector(`[data-detail="${GAME}"]`)).not.toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'All games' }));
    expect(container.querySelector('[data-detail]')).toBeNull();
    expect(window.location.search).toBe('?view=fanduel');
    expect(screen.getByRole('tab', { name: 'FanDuel' }).getAttribute('aria-selected')).toBe('true');
  });
});
