import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Delta, WireQuote } from '@shared/wire';
import { StoreContext, type OddsStore } from '../lib/store';
import { GAME, delta, manualStore, none, pick, quote, snapshot, status } from '../test/fixtures';
import { METHOD_TIPS, PriceCell, type PriceCellProps } from './PriceCell';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// The brief's example: DK home −3 −110 vs FD home −3.5 +100.
const dk = quote('draftkings', { line: -3, american: -110 });
const fd = quote('fanduel', { line: -3.5, american: 100 });

function renderCell(store: OddsStore, props: Partial<PriceCellProps> = {}) {
  const base: PriceCellProps = { game: GAME, market: 'spread', side: 'home', view: 'best', gameLive: false, gameSuspect: false, ...props };
  const ui = (p: PriceCellProps) => (
    <StoreContext value={store}>
      <PriceCell {...p} />
    </StoreContext>
  );
  const r = render(ui(base));
  const q = (sel: string) => r.container.querySelector<HTMLElement>(sel);
  return { ...r, q, rerenderWith: (more: Partial<PriceCellProps>) => r.rerender(ui({ ...base, ...more })) };
}

function tooltipOf(el: Element): string {
  const id = el.closest('[aria-describedby]')?.getAttribute('aria-describedby');
  return (id ? document.getElementById(id)?.textContent : null) ?? '';
}

/** Applies a delta as the stream does for a real-time frame on a visible tab, then renders the frame. */
function live(store: OddsStore, d: Delta, opts = { live: true }) {
  act(() => {
    store.applyDelta(d, opts);
    store.flush();
  });
}

const dkMove = (american: number, prevAmerican: number, at: number, over: Partial<WireQuote> = {}) =>
  quote('draftkings', { line: -3, american, prev: { american: prevAmerican, line: -3, at }, ...over });

describe('PriceCell — Best Price view', () => {
  it('R3: the best line and odds, the book underneath, and `est.` beside the book name (not the odds)', () => {
    const store = manualStore();
    const reason = 'DK −3 −110 returns .981 per $1 vs FD −3.5 +100 at .933.';
    store.applySnapshot(snapshot({ quotes: [dk, fd], bests: [pick({ exact: false, rule: 'R3', reason })] }));
    const { q } = renderCell(store);

    const price = q('[data-price]')!;
    expect(price.textContent).toBe('−3 −110');
    const books = q('[data-books]')!;
    expect(books.textContent).toContain('DK');
    const label = q('[data-method]')!;
    expect(label.textContent).toBe('est.');
    expect(books.contains(label)).toBe(true);
    expect(price.parentElement!.contains(label)).toBe(false);
    expect(tooltipOf(label)).toContain(METHOD_TIPS.est);
    expect(tooltipOf(label)).toContain(reason);
  });

  it('R4: `by line` with the no-model tooltip and the reason', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, fd], bests: [pick({ exact: false, rule: 'R4', reason: 'Live spread: pregame push rates do not apply.' })] }));
    const { q } = renderCell(store);
    const label = q('[data-method]')!;
    expect(label.textContent).toBe('by line');
    expect(q('[data-books]')!.contains(label)).toBe(true);
    expect(tooltipOf(label)).toContain(METHOD_TIPS.byLine);
    expect(tooltipOf(label)).toContain('Live spread: pregame push rates do not apply.');
  });

  it('exact picks carry no method label', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, quote('fanduel', { american: -115 })], bests: [pick({ exact: true, rule: 'R2' })] }));
    const { q } = renderCell(store);
    expect(q('[data-method]')).toBeNull();
    expect(q('[data-price]')!.textContent).toBe('−3 −110');
  });

  it('none: shows "—" and still lists the books it could not use', () => {
    const store = manualStore();
    store.applySnapshot(
      snapshot({
        quotes: [quote('draftkings', { suspended: true }), quote('fanduel', { suspended: true, line: -3.5, american: 100 })],
        bests: [none()],
      }),
    );
    const { q, container } = renderCell(store);
    expect(q('[data-none]')!.textContent).toContain('—');
    expect(container.querySelectorAll('[data-price]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-ineligible="suspended"]')).toHaveLength(2);
  });

  it('none with no quotes at all is just "—"', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ bests: [none()] }));
    const { q, container } = renderCell(store);
    expect(q('[data-none]')!.textContent).toContain('—');
    expect(container.querySelectorAll('[data-other]')).toHaveLength(0);
  });

  it('ties list every book: "DK · FD"', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, quote('fanduel')], bests: [pick({ books: ['draftkings', 'fanduel'], rule: 'R5' })] }));
    const { q, container } = renderCell(store);
    expect(q('[data-book-names]')!.textContent).toContain('DK · FD');
    expect(container.querySelectorAll('[data-other]')).toHaveLength(0);
  });

  it('the other book stays visible, muted, with its own line and price', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, fd], bests: [pick({ exact: false, rule: 'R3', reason: 'r' })] }));
    const { q } = renderCell(store);
    const other = q('[data-other="fanduel"]')!;
    expect(other.textContent).toBe('FD −3.5 +100');
    expect(other.className).toContain('text-faint');
    expect(other.closest('[data-ineligible]')).toBeNull();
    expect(q('[data-other="draftkings"]')).toBeNull();
  });

  it('when the stream is down, even the pick is shown stale', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, fd], bests: [pick()] }));
    store.setConnection('open', 1);
    const { q } = renderCell(store);
    expect(q('[data-ineligible]')).toBeNull();
    act(() => {
      store.setConnection('reconnecting', 1);
      store.flush();
    });
    const main = q('[data-price]')!.closest('[data-ineligible]')!;
    expect(main.getAttribute('data-ineligible')).toBe('stale');
    expect(tooltipOf(main)).toMatch(/^Not used for Best Price: the connection to the odds server is down/);
    expect(q('[data-other="fanduel"]')!.closest('[data-ineligible]')).not.toBeNull();
  });
});

describe('PriceCell — book views', () => {
  it('shows that book’s quote with ★ when it holds the best', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, fd], bests: [pick({ books: ['draftkings'] })] }));
    const { q, rerenderWith } = renderCell(store, { view: 'draftkings' });
    expect(q('[data-price]')!.textContent).toBe('−3 −110');
    expect(screen.getByRole('img', { name: 'Best price' })).toBeTruthy();
    rerenderWith({ view: 'fanduel' });
    expect(q('[data-price]')!.textContent).toBe('−3.5 +100');
    expect(screen.queryByRole('img', { name: 'Best price' })).toBeNull();
  });

  it('shows "—" when the book has no quote', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk] }));
    const { q } = renderCell(store, { view: 'fanduel' });
    expect(q('[data-none]')!.textContent).toContain('—');
  });

  it('moneyline shows odds only', () => {
    const store = manualStore();
    const ml = quote('draftkings', { market: 'moneyline', side: 'away', line: null, american: 145 });
    store.applySnapshot(snapshot({ quotes: [ml] }));
    const { q } = renderCell(store, { view: 'draftkings', market: 'moneyline', side: 'away' });
    expect(q('[data-price]')!.textContent).toBe('+145');
  });
});

describe('PriceCell — ineligible quotes', () => {
  it('stale book: hatched, tagged, explained, and never starred', () => {
    const store = manualStore();
    store.applySnapshot(
      snapshot({
        status: [status('draftkings'), status('fanduel', { stale: true, state: 'down' })],
        quotes: [dk, quote('fanduel')],
        bests: [pick({ books: ['draftkings', 'fanduel'], rule: 'R5' })],
      }),
    );
    const { q, rerenderWith } = renderCell(store, { view: 'fanduel' });
    const box = q('[data-ineligible]')!;
    expect(box.getAttribute('data-ineligible')).toBe('stale');
    expect(box.className).toContain('hatched');
    expect(q('[data-tag]')!.textContent).toBe('stale');
    expect(tooltipOf(box)).toBe("Not used for Best Price: FanDuel's feed is stale.");
    expect(screen.queryByRole('img', { name: 'Best price' })).toBeNull();
    rerenderWith({ view: 'draftkings' });
    expect(screen.getByRole('img', { name: 'Best price' })).toBeTruthy();
  });

  it('stream disconnected: every quote is stale', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk], bests: [pick()] }));
    store.setConnection('open', 1);
    store.setConnection('reconnecting', 1);
    const { q } = renderCell(store, { view: 'draftkings' });
    expect(q('[data-ineligible]')!.getAttribute('data-ineligible')).toBe('stale');
    expect(screen.queryByRole('img', { name: 'Best price' })).toBeNull();
  });

  it('suspended: lock icon and tag', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings', { suspended: true })], bests: [pick()] }));
    const { q } = renderCell(store, { view: 'draftkings' });
    const box = q('[data-ineligible]')!;
    expect(box.getAttribute('data-ineligible')).toBe('suspended');
    expect(box.querySelector('[data-icon="lock"]')).not.toBeNull();
    expect(tooltipOf(box)).toBe('Not used for Best Price: DraftKings has suspended betting on this market.');
    expect(screen.queryByRole('img', { name: 'Best price' })).toBeNull();
  });

  it('pre-game line on a live game', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings', { live: false })] }));
    const { q } = renderCell(store, { view: 'draftkings', gameLive: true });
    expect(q('[data-tag]')!.textContent).toBe('pre-game line');
    expect(tooltipOf(q('[data-ineligible]')!)).toContain("this is DraftKings' pre-game line and the game is live");
    expect(q('[data-icon="lock"]')).toBeNull();
  });

  it('a live quote on a live game is eligible', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings', { live: true })] }));
    const { q } = renderCell(store, { view: 'draftkings', gameLive: true });
    expect(q('[data-ineligible]')).toBeNull();
  });

  it('check: suspect game', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk] }));
    const { q } = renderCell(store, { view: 'draftkings', gameSuspect: true });
    expect(q('[data-tag]')!.textContent).toBe('check');
    expect(tooltipOf(q('[data-ineligible]')!)).toContain('the books disagree sharply on this game');
  });

  it('several reasons: first tag shown, all reasons in the tooltip', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [quote('draftkings', { suspended: true })] }));
    const { q } = renderCell(store, { view: 'draftkings', gameSuspect: true });
    const box = q('[data-ineligible]')!;
    expect(box.getAttribute('data-ineligible')).toBe('suspended,check');
    expect(q('[data-tag]')!.textContent).toBe('suspended');
    expect(tooltipOf(box)).toContain('suspended betting');
    expect(tooltipOf(box)).toContain('disagree sharply');
  });
});

describe('PriceCell — price-move flash', () => {
  it('book view: flashes green when the move favors the bettor, red when not, re-mounting the price each time', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, fd], bests: [pick()] }));
    const { q } = renderCell(store, { view: 'draftkings' });
    expect(q('[data-flash]')).toBeNull();

    live(store, delta(11, { quotes: [dkMove(-105, -110, 5_000)] }));
    const up = q('[data-price]')!;
    expect(up.getAttribute('data-flash')).toBe('up');
    expect(up.className).toContain('flash-up');
    expect(q('[data-prev]')!.textContent).toBe('was −110');

    live(store, delta(12, { quotes: [dkMove(-115, -105, 6_000)] }));
    const down = q('[data-price]')!;
    expect(down.getAttribute('data-flash')).toBe('down');
    expect(down.className).toContain('flash-down');
    expect(down).not.toBe(up); // a fresh element restarts the CSS animation
    expect(q('[data-prev]')!.textContent).toBe('was −105');
  });

  it('a line move shows the previous line and price', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk] }));
    const { q } = renderCell(store, { view: 'draftkings' });
    live(store, delta(11, { quotes: [quote('draftkings', { line: -3.5, american: 100, prev: { american: -110, line: -3, at: 5_000 } })] }));
    expect(q('[data-flash]')!.getAttribute('data-flash')).toBe('down'); // laying more points
    expect(q('[data-prev]')!.textContent).toBe('was −3 −110');
  });

  it('best view: flashes only on cause "price", never on an eligibility change', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, fd], bests: [pick()] }));
    const { q } = renderCell(store);

    live(store, delta(11, { bests: [pick({ american: -120, cause: 'eligibility' })] }));
    expect(q('[data-price]')!.textContent).toBe('−3 −120');
    expect(q('[data-flash]')).toBeNull();
    expect(q('[data-prev]')).toBeNull();

    live(store, delta(12, { bests: [pick({ american: -105, cause: 'price' })] }));
    expect(q('[data-flash]')!.getAttribute('data-flash')).toBe('up');
    expect(q('[data-prev]')!.textContent).toBe('was −120');
  });

  it('never flashes on a snapshot, and a snapshot clears a running flash', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk], bests: [pick()] }));
    const { q } = renderCell(store, { view: 'draftkings' });
    live(store, delta(11, { quotes: [dkMove(-105, -110, 5_000)] }));
    expect(q('[data-flash]')).not.toBeNull();

    act(() => {
      store.applySnapshot(snapshot({ seq: 30, quotes: [dkMove(-102, -105, Date.now())], bests: [pick({ american: -102 })] }));
      store.flush();
    });
    expect(q('[data-price]')!.textContent).toBe('−3 −102');
    expect(q('[data-flash]')).toBeNull();
    expect(q('[data-prev]')).toBeNull();
  });

  it('never flashes on an eligibility change of the quote itself', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk], bests: [pick()] }));
    const { q } = renderCell(store, { view: 'draftkings' });
    live(store, delta(11, { quotes: [quote('draftkings', { suspended: true })] }));
    live(store, delta(12, { quotes: [quote('draftkings', { suspended: false })] }));
    live(store, delta(13, { status: [status('draftkings', { stale: true })] }));
    live(store, delta(14, { status: [status('draftkings', { stale: false })] }));
    expect(q('[data-flash]')).toBeNull();
  });

  it('never flashes on a view switch', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk, fd], bests: [pick()] }));
    const { q, rerenderWith } = renderCell(store);
    live(store, delta(11, { quotes: [dkMove(-105, -110, 5_000)], bests: [pick({ american: -105 })] }));
    expect(q('[data-flash]')).not.toBeNull();

    rerenderWith({ view: 'draftkings' }); // the DK quote just moved too
    expect(q('[data-price]')!.textContent).toBe('−3 −105');
    expect(q('[data-flash]')).toBeNull();
    expect(q('[data-prev]')).toBeNull();

    rerenderWith({ view: 'best' });
    expect(q('[data-flash]')).toBeNull();

    // ...but the next real move in the new view does flash.
    live(store, delta(12, { quotes: [dkMove(-102, -105, 6_000)], bests: [pick({ american: -102 })] }));
    expect(q('[data-flash]')!.getAttribute('data-flash')).toBe('up');
  });

  it('never flashes for deltas that were not live (hidden tab, resume replay)', () => {
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk], bests: [pick()] }));
    const { q } = renderCell(store, { view: 'draftkings' });
    live(store, delta(11, { quotes: [dkMove(-105, -110, 5_000)] }), { live: false });
    expect(q('[data-price]')!.textContent).toBe('−3 −105');
    expect(q('[data-flash]')).toBeNull();
  });

  it('shows the previous price for 5 s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 25, 17));
    const store = manualStore();
    store.applySnapshot(snapshot({ quotes: [dk] }));
    const { q } = renderCell(store, { view: 'draftkings' });
    live(store, delta(11, { quotes: [dkMove(-105, -110, Date.now())] }));
    expect(q('[data-prev]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(4_000));
    expect(q('[data-prev]')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1_500));
    expect(q('[data-prev]')).toBeNull();
    expect(q('[data-price]')!.textContent).toBe('−3 −105');
  });
});
