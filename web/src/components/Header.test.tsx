import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookId } from '@shared/domain';
import { StoreContext, type OddsStore } from '../lib/store';
import { BOOKS, manualStore, snapshot, status } from '../test/fixtures';
import { Header } from './Header';
import { StaleBanner } from './StaleBanner';

const NOW = Date.UTC(2026, 9, 25, 17, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const withStore = (store: OddsStore, ui: ReactNode) => render(<StoreContext value={store}>{ui}</StoreContext>);
const chip = (book: string) => document.querySelector<HTMLElement>(`[data-book="${book}"]`)!;
const tooltipOf = (el: Element) => {
  const id = el.closest('[aria-describedby]')?.getAttribute('aria-describedby');
  return (id ? document.getElementById(id)?.textContent : '') ?? '';
};

describe('ViewToggle (in the header)', () => {
  it('has Best Price plus one tab per book from the snapshot, so a third book needs no UI change', () => {
    const store = manualStore();
    const caesars = { id: 'caesars' as string as BookId, name: 'Caesars', short: 'CZ', color: '#c4a35a' };
    store.applySnapshot(snapshot({ books: [...BOOKS, caesars], status: [] }));
    const onView = vi.fn();
    withStore(store, <Header view="fanduel" onView={onView} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Best Price', 'DraftKings', 'FanDuel', 'Caesars']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false']);
    expect(tabs.map((t) => t.tabIndex)).toEqual([-1, -1, 0, -1]);

    fireEvent.click(tabs[0]!);
    expect(onView).toHaveBeenLastCalledWith('best');
    fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
    expect(onView).toHaveBeenLastCalledWith('caesars');
    fireEvent.keyDown(tabs[2]!, { key: 'Home' });
    expect(onView).toHaveBeenLastCalledWith('best');
  });

  it('shows only Best Price before the registry arrives', () => {
    withStore(manualStore(), <Header view="best" onView={() => {}} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Best Price']);
    expect(screen.getByRole('status').textContent).toContain('Connecting');
  });
});

describe('BookStatusChip', () => {
  it('live: last move age and feed count, per-feed detail in the tooltip', () => {
    const store = manualStore();
    store.applySnapshot(
      snapshot({
        status: [
          status('draftkings', { lastChangeAt: NOW - 3_000, lastDataAt: NOW - 500 }),
          status('fanduel', {
            lastChangeAt: NOW - 125_000,
            feeds: [
              { id: 'A', state: 'live', stale: false, detail: null, lastDataAt: NOW - 1_000 },
              { id: 'B', state: 'down', stale: true, detail: 'link down', lastDataAt: NOW - 60_000 },
            ],
          }),
        ],
      }),
    );
    withStore(store, <Header view="best" onView={() => {}} />);
    const dk = chip('draftkings');
    expect(dk.getAttribute('data-level')).toBe('live');
    expect(dk.textContent).toContain('live');
    expect(dk.textContent).toContain('last move 3s ago');
    expect(dk.textContent).toContain('2 feeds');

    const fd = chip('fanduel');
    expect(fd.textContent).toContain('last move 2m ago');
    expect(fd.textContent).toContain('1/2 feeds');
    const tip = tooltipOf(fd);
    expect(tip).toContain('Feed A: live · data 1s ago');
    expect(tip).toContain('Feed B: stale · no data for 1m — link down');
  });

  it('stale / down: says how long the book has been silent', () => {
    const store = manualStore();
    store.applySnapshot(
      snapshot({
        status: [
          status('draftkings', { stale: true, state: 'live', lastDataAt: NOW - 45_000 }),
          status('fanduel', { stale: true, state: 'down', lastDataAt: NOW - 125_000 }),
        ],
      }),
    );
    withStore(store, <Header view="best" onView={() => {}} />);
    expect(chip('draftkings').getAttribute('data-level')).toBe('stale');
    expect(chip('draftkings').textContent).toContain('no data for 45s');
    expect(chip('fanduel').getAttribute('data-level')).toBe('down');
    expect(chip('fanduel').textContent).toContain('no data for 2m');
  });

  it('ages tick with the shared clock', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ status: [status('draftkings', { lastChangeAt: NOW - 3_000 }), status('fanduel')] }));
    withStore(store, <Header view="best" onView={() => {}} />);
    expect(chip('draftkings').textContent).toContain('last move 3s ago');
    act(() => vi.advanceTimersByTime(2_000));
    expect(chip('draftkings').textContent).toContain('last move 5s ago');
  });

  it('connection indicator follows the stream state', () => {
    const store = manualStore();
    store.applySnapshot(snapshot());
    withStore(store, <Header view="best" onView={() => {}} />);
    act(() => {
      store.setConnection('open', NOW);
      store.flush();
    });
    expect(screen.getByRole('status').textContent).toBe('Live');
    act(() => {
      store.setConnection('reconnecting', NOW);
      store.flush();
    });
    expect(screen.getByRole('status').textContent).toBe('Reconnecting…');
    expect(chip('draftkings').getAttribute('data-level')).toBe('stale');
  });
});

describe('StaleBanner', () => {
  it('is absent while everything is fresh', () => {
    const store = manualStore();
    store.applySnapshot(snapshot());
    const { container } = withStore(store, <StaleBanner />);
    expect(container.textContent).toBe('');
  });

  it('names a stale book and how old its prices are', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ status: [status('draftkings'), status('fanduel', { stale: true, state: 'down', lastDataAt: NOW - 125_000 })] }));
    withStore(store, <StaleBanner />);
    expect(screen.getByRole('status').textContent).toBe('FanDuel feed down — showing last known prices from 2m ago.');
  });

  it('while the stream is down, the whole board is stale', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ status: [status('draftkings'), status('fanduel', { stale: true })] }));
    store.setConnection('open', NOW - 12_000);
    store.setConnection('reconnecting', NOW - 12_000);
    withStore(store, <StaleBanner />);
    expect(screen.getByRole('status').textContent).toBe('Reconnecting to the odds server — showing last known prices from 12s ago.');
  });
});
