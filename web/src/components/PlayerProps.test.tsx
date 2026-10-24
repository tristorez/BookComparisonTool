import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { PropGroup } from '@shared/props';
import type { PropsResponse, WirePropRow, WirePropsBook } from '@shared/wire';
import { PropsContext, type PropsClient } from '../lib/props';
import { StoreContext } from '../lib/store';
import { game, manualStore, propsBooks, propsClient, propsResponse, snapshot } from '../test/fixtures';
import { PlayerProps } from './PlayerProps';

afterEach(() => {
  cleanup();
});

const KC_SEA = game({ key: '2026-10-25:KC@SEA', away: 'KC', home: 'SEA', awayName: 'Kansas City Chiefs', homeName: 'Seattle Seahawks' });

/** Receiving props as the server lines them up for KC @ SEA (taken from the real reads in test/props.test.ts). */
const RECEIVING: WirePropRow[] = [
  {
    stat: 'rec_yds',
    player: 'jaxon smith njigba',
    name: 'Jaxon Smith-Njigba',
    team: 'home',
    offers: { draftkings: { line: 94.5, prices: { over: -111, under: -113 }, suspended: false }, fanduel: { line: 92.5, prices: { over: -114, under: -114 }, suspended: false } },
    best: { over: { books: ['fanduel'], exact: false }, under: { books: ['draftkings'], exact: false } },
  },
  {
    stat: 'rec_yds',
    player: 'travis kelce',
    name: 'Travis Kelce',
    team: 'away',
    offers: { draftkings: { line: 46.5, prices: { over: -111, under: -113 }, suspended: false }, fanduel: { line: 46.5, prices: { over: -114, under: -114 }, suspended: false } },
    best: { over: { books: ['draftkings'], exact: true }, under: { books: ['draftkings'], exact: true } },
  },
  {
    stat: 'receptions',
    player: 'kenneth walker',
    name: 'Kenneth Walker III',
    team: 'away',
    offers: { draftkings: { line: 3.5, prices: { over: 125, under: -160 }, suspended: false }, fanduel: { line: 3.5, prices: { over: 120, under: -160 }, suspended: false } },
    best: { over: { books: ['draftkings'], exact: true }, under: { books: ['draftkings', 'fanduel'], exact: true } },
  },
  {
    stat: 'rec_long',
    player: 'travis kelce',
    name: 'Travis Kelce',
    team: 'away',
    offers: { draftkings: { line: 18.5, prices: { over: -120, under: -108 }, suspended: false } },
    best: {},
  },
];

const ANYTIME: WirePropRow = {
  stat: 'td_anytime',
  player: 'kenneth walker',
  name: 'Kenneth Walker III',
  team: 'away',
  offers: { draftkings: { line: null, prices: { yes: -130 }, suspended: false }, fanduel: { line: null, prices: { yes: -125 }, suspended: false } },
  best: { yes: { books: ['fanduel'], exact: true } },
};

/** Each group's rows (none unless given), with every book read fine unless `books` says otherwise. */
const byGroup = (rows: Partial<Record<PropGroup, WirePropRow[]>>, books?: WirePropsBook[]) => (group: PropGroup): PropsResponse =>
  propsResponse(group, rows[group] ?? [], { game: KC_SEA.key, ...(books && { books }) });

function renderProps(props: PropsClient, store = manualStore()) {
  if (!store.isLoaded()) store.applySnapshot(snapshot());
  return render(
    <StoreContext value={store}>
      <PropsContext value={props}>
        <PlayerProps game={KC_SEA} />
      </PropsContext>
    </StoreContext>,
  );
}

const openTab = (name: string) => fireEvent.click(screen.getByRole('tab', { name }));
const table = (label: string) => screen.getByRole('region', { name: label });
/** One book's cell for one side of a player's prop. */
const price = (el: HTMLElement, player: string, book: string, side: string) =>
  el.querySelector<HTMLElement>(`tbody[data-player="${player}"] tr[data-book="${book}"] td[data-side="${side}"]`)!;
const players = (el: HTMLElement) => [...el.querySelectorAll('th[scope="rowgroup"]')].map((h) => h.textContent);
const stars = (el: HTMLElement) => within(el).queryAllByRole('img').map((s) => s.getAttribute('aria-label'));
/** Visible text of a price cell: the price and its star, without the screen-reader-only words. */
const shown = (el: HTMLElement) => {
  const copy = el.cloneNode(true) as HTMLElement;
  for (const sr of copy.querySelectorAll('.sr-only')) sr.remove();
  return copy.textContent;
};

describe('PlayerProps', () => {
  it('lays each stat out like the market tables: per player, the sportsbooks down the left and the sides across, the better side starred', async () => {
    const props = propsClient(byGroup({ receiving: RECEIVING }));
    renderProps(props);
    openTab('Receiving');
    await screen.findByRole('heading', { level: 4, name: 'Receiving Yards' });
    expect(props.calls.at(-1)).toBe(`/api/games/${encodeURIComponent(KC_SEA.key)}/props?group=receiving`);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Receiving Yards', 'Receptions', 'Longest Reception']);

    const yards = table('Receiving Yards');
    expect(within(yards).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Player', 'Sportsbook', 'Over', 'Under']);
    expect(players(yards)).toEqual(['Jaxon Smith-Njigba SEA', 'Travis Kelce KC']);
    // A row per registry book under every player, so another book is another row, not another column.
    expect([...yards.querySelectorAll('tbody[data-player="travis kelce"] tr')].map((r) => r.getAttribute('data-book'))).toEqual(['draftkings', 'fanduel']);
    expect(shown(price(yards, 'jaxon smith njigba', 'draftkings', 'over'))).toBe('o94.5 −111');
    // Lines differ (94.5 vs 92.5): FD's lower line wins the over, DK's higher line the under.
    expect(stars(price(yards, 'jaxon smith njigba', 'fanduel', 'over'))).toEqual(['Best price, on a better line']);
    expect(stars(price(yards, 'jaxon smith njigba', 'draftkings', 'under'))).toEqual(['Best price, on a better line']);
    expect(stars(yards.querySelector<HTMLElement>('tbody[data-player="jaxon smith njigba"]')!)).toHaveLength(2);
    // Same line: DK pays more on both sides.
    expect(stars(price(yards, 'travis kelce', 'draftkings', 'over'))).toEqual(['Best price']);
    expect(stars(price(yards, 'travis kelce', 'draftkings', 'under'))).toEqual(['Best price']);
    expect(stars(yards.querySelector<HTMLElement>('tbody[data-player="travis kelce"] tr[data-book="fanduel"]')!)).toEqual([]);
    // A tie stars both books.
    const receptions = table('Receptions');
    expect(stars(price(receptions, 'kenneth walker', 'draftkings', 'under'))).toEqual(['Best price']);
    expect(stars(price(receptions, 'kenneth walker', 'fanduel', 'under'))).toEqual(['Best price']);
    // Only DK offers it: shown, nothing starred, FD's row says so.
    const longest = table('Longest Reception');
    expect(stars(longest)).toEqual([]);
    expect(price(longest, 'travis kelce', 'fanduel', 'over').textContent).toBe('—Not offered');
  });

  it('says how many props each book listed and how old they are', async () => {
    renderProps(propsClient(byGroup({ receiving: RECEIVING }, propsBooks(Date.now() - 3_000))));
    openTab('Receiving');
    const list = await screen.findByRole('list', { name: 'Sportsbook props status' });
    // Ages come from the shared 1 s ticker, so the exact second depends on where in its tick the render lands.
    expect((await within(list).findByText(/^4 props · updated \ds ago$/)).closest('li')?.getAttribute('data-prop-book')).toBe('draftkings');
    expect(within(list).getByText(/^3 props · updated \ds ago$/).closest('li')?.getAttribute('data-prop-book')).toBe('fanduel');
  });

  it('says when a book refused the read, and when one has none posted yet', async () => {
    const books: WirePropsBook[] = [
      { book: 'draftkings', state: 'error', detail: 'HTTP 403, refused by the book', fetchedAt: null },
      { book: 'fanduel', state: 'ok', detail: null, fetchedAt: Date.now() },
    ];
    renderProps(propsClient(byGroup({}, books)));
    const list = await screen.findByRole('list', { name: 'Sportsbook props status' });
    expect(await within(list).findByText('unavailable (HTTP 403, refused by the book)')).toBeTruthy();
    expect(within(list).getByText('none listed yet')).toBeTruthy();
    expect(screen.getByText('No passing props listed for this game yet.')).toBeTruthy();
  });

  it('tells a book whose feed is down from one that doesn’t list the game', async () => {
    const books: WirePropsBook[] = [
      { book: 'draftkings', state: 'down', detail: null, fetchedAt: null },
      { book: 'fanduel', state: 'unlisted', detail: null, fetchedAt: null },
    ];
    renderProps(propsClient(byGroup({}, books)));
    const list = await screen.findByRole('list', { name: 'Sportsbook props status' });
    expect((await within(list).findByText('feed down')).closest('li')?.getAttribute('data-prop-book')).toBe('draftkings');
    expect(within(list).getByText("doesn't list this game").closest('li')?.getAttribute('data-prop-book')).toBe('fanduel');
    expect(screen.getByText("No sportsbook's passing props are available right now.")).toBeTruthy();
  });

  it('moves between groups with the tabs, by click or arrow key, and reads each group', async () => {
    const props = propsClient(byGroup({ touchdowns: [ANYTIME] }));
    renderProps(props);
    expect(screen.getByRole('tab', { name: 'Passing' }).getAttribute('aria-selected')).toBe('true');
    await screen.findByText('No passing props listed for this game yet.');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Passing' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Touchdowns' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Touchdowns' }));
    const anytime = await screen.findByRole('region', { name: 'Anytime TD Scorer' });
    expect(props.calls.at(-1)).toContain('group=touchdowns');
    expect(within(anytime).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Player', 'Sportsbook', 'Price']);
    expect(shown(price(anytime, 'kenneth walker', 'fanduel', 'yes'))).toBe('−125★');
    expect(shown(price(anytime, 'kenneth walker', 'draftkings', 'yes'))).toBe('−130');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Touchdowns' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Passing' }).getAttribute('aria-selected')).toBe('true');
  });

  it('says when it can’t read props', async () => {
    renderProps(propsClient(() => 500));
    expect(await screen.findByText("Couldn't load player props (HTTP 500). Retrying every 15 s.")).toBeTruthy();
  });

  it('keeps the last props on screen when a refresh fails', async () => {
    let fail = false;
    renderProps(propsClient((group) => (fail ? 503 : byGroup({ touchdowns: [ANYTIME] })(group)), 30));
    openTab('Touchdowns');
    await screen.findByRole('region', { name: 'Anytime TD Scorer' });
    fail = true; // the next re-read, 30 ms on, fails
    expect(await screen.findByText("Couldn't refresh (HTTP 503); showing the last props read.")).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Anytime TD Scorer' })).toBeTruthy();
  });

  it('hatches a suspended offer the way the board does, and never stars it', async () => {
    const suspended: WirePropRow = { ...ANYTIME, offers: { ...ANYTIME.offers, fanduel: { line: null, prices: { yes: -125 }, suspended: true } }, best: {} };
    renderProps(propsClient(byGroup({ touchdowns: [suspended] })));
    openTab('Touchdowns');
    const fd = price(await screen.findByRole('region', { name: 'Anytime TD Scorer' }), 'kenneth walker', 'fanduel', 'yes');
    expect(fd.querySelector('[data-ineligible="suspended"]')).not.toBeNull();
    expect(fd.querySelector('[data-icon="lock"]')).not.toBeNull();
    expect(stars(fd)).toEqual([]);
  });

  it('hatches a book’s last props as stale while its reads fail, and never stars them', async () => {
    const books: WirePropsBook[] = [
      { book: 'draftkings', state: 'error', detail: 'timed out', fetchedAt: Date.now() - 20_000 },
      { book: 'fanduel', state: 'ok', detail: null, fetchedAt: Date.now() },
    ];
    // The server stars nothing for Kelce: DK's −111 is from a read that can't be refreshed.
    const kelce: WirePropRow = { ...RECEIVING[1]!, best: {} };
    renderProps(propsClient(byGroup({ receiving: [kelce] }, books)));
    openTab('Receiving');
    const yards = await screen.findByRole('region', { name: 'Receiving Yards' });
    const dkOver = price(yards, 'travis kelce', 'draftkings', 'over');
    expect(dkOver.querySelector('[data-ineligible="stale"]')).not.toBeNull();
    expect(within(dkOver).getByRole('tooltip').textContent).toBe("Not used for Best Price: DraftKings' props couldn't be refreshed (timed out).");
    expect(price(yards, 'travis kelce', 'fanduel', 'over').querySelector('[data-ineligible]')).toBeNull();
    expect(stars(yards)).toEqual([]);
    expect(screen.getByText(/^refresh failed \(timed out\) · props from \d+s ago$/)).toBeTruthy();
  });

  it('says a book’s props are not available, rather than not offered, when it couldn’t be read', async () => {
    const books: WirePropsBook[] = [
      { book: 'draftkings', state: 'down', detail: null, fetchedAt: null },
      { book: 'fanduel', state: 'ok', detail: null, fetchedAt: Date.now() },
    ];
    const fdOnly: WirePropRow = { ...RECEIVING[1]!, offers: { fanduel: RECEIVING[1]!.offers.fanduel! }, best: {} };
    renderProps(propsClient(byGroup({ receiving: [fdOnly] }, books)));
    openTab('Receiving');
    const yards = await screen.findByRole('region', { name: 'Receiving Yards' });
    expect(price(yards, 'travis kelce', 'draftkings', 'over').textContent).toBe('—Not available');
  });

  it('shows nothing about the books until a read answers, and survives a stat or state from a newer server', async () => {
    renderProps(propsClient(() => 500));
    await screen.findByText("Couldn't load player props (HTTP 500). Retrying every 15 s.");
    expect(screen.queryByRole('list', { name: 'Sportsbook props status' })).toBeNull();
    cleanup();

    const newer = { ...RECEIVING[0]!, stat: 'rec_targets' } as unknown as WirePropRow;
    const books = [{ book: 'draftkings', state: 'paused', detail: null, fetchedAt: null }, propsBooks()[1]!] as unknown as WirePropsBook[];
    renderProps(propsClient(byGroup({ receiving: [newer, RECEIVING[1]!] }, books)));
    openTab('Receiving');
    expect(await screen.findByRole('region', { name: 'Receiving Yards' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Receiving Yards']);
    expect(screen.getByText('unavailable')).toBeTruthy();
  });

  it('doesn’t flash a change against a read from minutes ago, or an offer that dropped out and came back', async () => {
    let ts = Date.now();
    let over: number | null = 125;
    const kw = (): WirePropRow => {
      const base = RECEIVING[2]!;
      return over === null ? { ...base, offers: { fanduel: base.offers.fanduel! }, best: {} } : { ...base, offers: { ...base.offers, draftkings: { line: 3.5, prices: { over, under: -160 }, suspended: false } } };
    };
    renderProps(propsClient((group) => ({ ...byGroup({ receiving: [kw()] })(group), ts }), 30));
    openTab('Receiving');
    await screen.findByText('+125');
    // The next read lands a minute of board time after the last: a repaint, not a move.
    ts += 60_000;
    over = 135;
    await screen.findByText('+135');
    expect(table('Receptions').querySelector('[data-flash]')).toBeNull();
    // DK's offer drops out, then comes back at another price: no flash against the old one.
    over = null;
    await screen.findAllByText('Not offered');
    over = 145;
    await screen.findByText('+145');
    expect(table('Receptions').querySelector('[data-flash]')).toBeNull();
  });

  it('flashes a price that moved between two reads, green when it got better for the bettor, beside the old price', async () => {
    let over = 125;
    const receptions = (): WirePropRow => ({ ...RECEIVING[2]!, offers: { ...RECEIVING[2]!.offers, draftkings: { line: 3.5, prices: { over, under: -160 }, suspended: false } } });
    renderProps(propsClient((group) => byGroup({ receiving: [receptions()] })(group), 30));
    openTab('Receiving');
    const first = await screen.findByRole('region', { name: 'Receptions' });
    expect(first.querySelector('[data-flash]')).toBeNull(); // a tab's first read moves nothing
    over = 135; // the next re-read, 30 ms on, sees the move
    await screen.findByText('+135');
    const dkOver = price(table('Receptions'), 'kenneth walker', 'draftkings', 'over');
    expect(dkOver.querySelector('[data-flash="up"]')).not.toBeNull();
    expect(dkOver.querySelector('[data-prev]')?.textContent).toBe('was +125');
    expect(price(table('Receptions'), 'kenneth walker', 'fanduel', 'over').querySelector('[data-flash]')).toBeNull();
  });
});
