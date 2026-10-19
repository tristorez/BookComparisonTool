import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { StoreContext, type OddsStore } from '../lib/store';
import { GAME, game, manualStore, pick, quote, snapshot } from '../test/fixtures';
import { Board } from './Board';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const withStore = (store: OddsStore, ui: ReactNode) => render(<StoreContext value={store}>{ui}</StoreContext>);

describe('Board', () => {
  it('says it is connecting before the first snapshot', () => {
    withStore(manualStore(), <Board view="best" />);
    expect(screen.getByText('Connecting to live odds…')).toBeTruthy();
  });

  it('says so when no game has quotes', () => {
    const store = manualStore();
    store.applySnapshot(snapshot());
    withStore(store, <Board view="best" />);
    expect(screen.getByText(/No NFL games on the board right now/)).toBeTruthy();
  });

  it('live first, then ET dates; away above home; Spread | Total | Moneyline', () => {
    const store = manualStore();
    const later = game({ key: '2026-10-26:WAS@SF', away: 'WAS', home: 'SF', awayName: 'Washington Commanders', homeName: 'San Francisco 49ers', start: '2026-10-27T00:15:00Z' });
    const live = game({ key: '2026-10-25:KC@BUF', away: 'KC', home: 'BUF', awayName: 'Kansas City Chiefs', homeName: 'Buffalo Bills', live: true });
    const empty = game({ key: '2026-10-25:NYJ@MIA', away: 'NYJ', home: 'MIA', awayName: 'New York Jets', homeName: 'Miami Dolphins' });
    store.applySnapshot(
      snapshot({
        games: [later, game(), live, empty],
        quotes: [quote('draftkings'), quote('draftkings', { game: later.key }), quote('fanduel', { game: live.key, live: true })],
        bests: [pick()],
      }),
    );
    withStore(store, <Board view="best" />);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Live· 1 game',
      'Sunday, Oct 25· 1 game',
      'Monday, Oct 26· 1 game',
    ]);
    expect(screen.queryByRole('article', { name: 'New York Jets at Miami Dolphins' })).toBeNull();

    const card = screen.getByRole('article', { name: 'Pittsburgh Steelers at New Orleans Saints' });
    expect(within(card).getAllByRole('columnheader').map((h) => h.textContent).slice(1)).toEqual(['Spread', 'Total', 'Moneyline']);
    expect(card.getAttribute('data-game')).toBe(GAME);
    const rows = within(card).getAllByRole('rowheader');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/^PIT/);
    expect(rows[1]!.textContent).toMatch(/^NO/);
    expect(within(screen.getByRole('article', { name: 'Kansas City Chiefs at Buffalo Bills' })).getByText('Live')).toBeTruthy();
  });
});

describe('App view sync', () => {
  function setup() {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings'), quote('fanduel', { line: -3.5, american: 100 })], bests: [pick()] }));
    return withStore(store, <App />);
  }

  it('reads ?view= and writes it back on toggle', () => {
    window.history.replaceState(null, '', '/?view=fanduel');
    const { container } = setup();
    expect(screen.getByRole('tab', { name: 'FanDuel' }).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-cell="fanduel"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'Best Price' }));
    expect(window.location.search).toBe('?view=best');
    expect(container.querySelector('[data-cell="best"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'DraftKings' }));
    expect(window.location.search).toBe('?view=draftkings');
    expect(container.querySelector('[data-cell="draftkings"]')).not.toBeNull();
  });

  it('falls back to Best Price for an unknown book', () => {
    window.history.replaceState(null, '', '/?view=bovada');
    const { container } = setup();
    expect(screen.getByRole('tab', { name: 'Best Price' }).getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-cell="best"]')).not.toBeNull();
  });
});
