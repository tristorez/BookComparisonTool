import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseDkProps } from '../src/books/draftkings.js';
import { FanDuelConnector, parseFdProps } from '../src/books/fanduel.js';
import { HttpError } from '../src/books/http.js';
import type { BookGame, BookProp } from '../src/books/types.js';
import { buildApp } from '../src/server/app.js';
import { Board } from '../src/server/board.js';
import { FakeConnector } from '../src/server/fake.js';
import { LatencyTracker } from '../src/server/latency.js';
import { mergeProps, PropsService, type PropsOptions, type PropsReader } from '../src/server/props.js';
import { BOOKS } from '../src/server/registry.js';
import { SseHub } from '../src/server/sse.js';
import type { BookId } from '../src/shared/domain.js';
import { PROP_STATS, playerKey } from '../src/shared/props.js';
import type { PropsResponse } from '../src/shared/wire.js';

/** Real payloads for KC @ SEA (2026-10-25), read on 2026-10-23 and trimmed to a few players each. */
const fixture = (name: string): any => JSON.parse(readFileSync(new URL(`./fixtures/props/${name}`, import.meta.url), 'utf8'));
const GAME = '2026-10-25:KC@SEA';
const game = (book: BookId, bookEventId: string): BookGame => ({ book, gameKey: GAME, bookEventId, away: 'KC', home: 'SEA', startTime: '2026-10-26T00:20:00.000Z', live: false });
const FD_GAME = game('fanduel', '36189006');
/** One DK category page, parsed. */
const dk = (tab: 'receiving' | 'td') => parseDkProps(fixture(`dk-event-${tab}.json`), '34118035');
const fdMarkets = (tab: 'receiving' | 'td'): Parameters<typeof parseFdProps>[0] => Object.values(fixture(`fd-event-${tab}.json`).attachments.markets);
/** SMP's answer for every market of a tab, at the page's own prices. */
const smpAll = (tab: 'receiving' | 'td') => fdMarkets(tab).map((m) => ({ marketId: m.marketId, marketStatus: 'OPEN', runnerDetails: m.runners }));
/** One FD event-page tab, parsed with SMP's answer by market id (every market at the page's prices unless given). */
const fd = (tab: 'receiving' | 'td', smp?: Parameters<typeof parseFdProps>[1]) => parseFdProps(fdMarkets(tab), smp ?? new Map(smpAll(tab).map((u) => [u.marketId, u])), FD_GAME);
const find = (props: readonly BookProp[], stat: string, player: string) => props.find((p) => p.stat === stat && p.player === player);

describe('reading each book’s props', () => {
  it('DraftKings: full-game over/unders with the player and their side, from DK’s own category page', () => {
    const props = dk('receiving');
    expect(find(props, 'rec_yds', 'Travis Kelce')).toEqual({ stat: 'rec_yds', player: 'Travis Kelce', team: 'away', line: 46.5, prices: { over: -111, under: -113 }, suspended: false });
    expect(find(props, 'receptions', 'A.J. Barner')).toMatchObject({ team: 'home', line: 2.5, prices: { over: -142, under: 111 } });
    expect(find(props, 'rec_long', 'Travis Kelce')).toMatchObject({ line: 18.5 });
    // The fixture also carries Kelce's milestone ladder and first-half line: other markets, left out.
    expect(props).toHaveLength(6);
  });

  it('DraftKings: scorer markets are one price per player; team D/ST and "No Touchdown Scorer" are not players', () => {
    const props = dk('td');
    expect(find(props, 'td_anytime', 'Kenneth Walker III')).toEqual({ stat: 'td_anytime', player: 'Kenneth Walker III', team: 'away', line: null, prices: { yes: -130 }, suspended: false });
    expect(find(props, 'td_first', 'Travis Kelce')?.prices).toEqual({ yes: 1300 });
    expect(props.map((p) => p.player)).not.toContain('KC Chiefs D/ST');
    expect(props.map((p) => p.player)).not.toContain('No Touchdown Scorer');
    // Four players on anytime and first; "either player" and first-half markets are left out.
    expect(props).toHaveLength(8);
  });

  it('DraftKings: a page without the game’s event, or with markets but no selections, is an error, not "no props"', () => {
    const page = fixture('dk-event-receiving.json');
    // A game with no props posted yet: its event, and no markets or selections at all.
    expect(parseDkProps({ events: page.events }, '34118035')).toEqual([]);
    expect(() => parseDkProps({ ...page, events: [] }, '34118035')).toThrow(/event 34118035 missing/);
    expect(() => parseDkProps({ ...page, events: [{ id: '999' }] }, '34118035')).toThrow(/event 34118035 missing/);
    expect(() => parseDkProps({ events: page.events, markets: page.markets }, '34118035')).toThrow(/markets without selections/);
  });

  it('FanDuel: PLAYER_X over/unders by name and tier, the player from the market name, the team from the jersey logo', () => {
    const props = fd('receiving');
    expect(find(props, 'rec_yds', 'Travis Kelce')).toEqual({ stat: 'rec_yds', player: 'Travis Kelce', team: 'away', line: 46.5, prices: { over: -114, under: -114 }, suspended: false });
    expect(find(props, 'receptions', 'AJ Barner')).toMatchObject({ team: 'home', line: 2.5, prices: { over: -158, under: 118 } });
    // FD files rush + receiving yards under receiving too; the service shows it on the rushing tab.
    expect(find(props, 'rush_rec_yds', 'Kenneth Walker III')).toMatchObject({ line: 107.5 });
    // Alt ladders, "20+ yard reception", "most receiving yards" and the moneyline are left out.
    expect(props).toHaveLength(6);
    // FD lists "Seattle Defense" among scorers, flagged a player selection; it isn't a player prop.
    expect(fd('td').map((p) => p.player)).not.toContain('Seattle Defense');
    expect(fd('td').map((p) => `${p.stat} ${p.player} ${p.prices.yes}`).sort()).toEqual([
      'td_anytime Jaxon Smith-Njigba 120',
      'td_anytime Kenneth Walker III -125',
      'td_anytime Travis Kelce 210',
      'td_anytime Zach Charbonnet 125',
      'td_first Jaxon Smith-Njigba 650',
      'td_first Kenneth Walker III 470',
      'td_first Travis Kelce 1200',
      'td_first Zach Charbonnet 600',
    ]);
  });

  it('FanDuel: SMP’s fresh price, line and status replace the CDN-cached page’s, and a market SMP leaves out is closed', () => {
    const smp = new Map([
      // Kelce's line moved since the page was cached.
      [
        '734.193061835',
        {
          marketId: '734.193061835',
          marketStatus: 'OPEN',
          runnerDetails: [
            { selectionId: 11802406, handicap: 47.5, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: -105 } } },
            { selectionId: 11802405, handicap: 47.5, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: -125 } } },
          ],
        },
      ],
      ['734.192727331', { marketId: '734.192727331', marketStatus: 'SUSPENDED' }],
    ]) as Parameters<typeof parseFdProps>[1];
    const props = fd('receiving', smp);
    expect(find(props, 'rec_yds', 'Travis Kelce')).toMatchObject({ line: 47.5, prices: { over: -105, under: -125 }, suspended: false });
    // SMP returned no runners for JSN, so the page's prices stand, but the market is suspended.
    expect(find(props, 'rec_yds', 'Jaxon Smith-Njigba')).toMatchObject({ line: 92.5, prices: { over: -114, under: -114 }, suspended: true });
    // SMP answered without Worthy's market (SMP omits closed markets): the cached page's price is not offered as open.
    expect(find(props, 'rec_yds', 'Xavier Worthy')?.suspended).toBe(true);
    expect(find(fd('receiving'), 'rec_yds', 'Xavier Worthy')?.suspended).toBe(false);
  });

  it('FanDuel: an over/under whose two sides quote different lines is skipped, not shown at one side’s line', () => {
    const smp = new Map(smpAll('receiving').map((u) => [u.marketId, u])) as Parameters<typeof parseFdProps>[1] & Map<string, unknown>;
    // SMP answers only Kelce's over, at a moved line; the page's under is still at 46.5.
    smp.set('734.193061835', {
      marketId: '734.193061835',
      marketStatus: 'OPEN',
      runnerDetails: [{ selectionId: 11802406, handicap: 49.5, runnerStatus: 'ACTIVE', winRunnerOdds: { americanDisplayOdds: { americanOddsInt: -105 } } }],
    });
    expect(find(fd('receiving', smp), 'rec_yds', 'Travis Kelce')).toBeUndefined();
  });

  it('matches players across books despite punctuation, accents and suffixes', () => {
    expect(playerKey('A.J. Barner')).toBe(playerKey('AJ Barner'));
    expect(playerKey('Kenneth Walker III')).toBe(playerKey('Kenneth Walker'));
    expect(playerKey('Calvin Ridley Jr.')).toBe('calvin ridley');
    expect(playerKey("Ja'Marr Chase")).toBe('jamarr chase');
    expect(playerKey('Amon-Ra St. Brown')).toBe('amon ra st brown');
    expect(playerKey('José Ramírez')).toBe('jose ramirez');
    expect(playerKey('A. J. Brown')).toBe(playerKey('AJ Brown'));
    expect(playerKey('Ja’Marr Chase')).toBe(playerKey('JaʼMarr Chase'));
  });
});

describe('FanDuel props reads', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A connector whose network is stubbed: a tab's page (the receiving fixture unless given), and SMP answering with `smp(ids)` (or throwing it). */
  function connector(smp: (ids: string[]) => unknown, page: unknown = fixture('fd-event-receiving.json')) {
    const c = new FanDuelConnector({ push: false, pollIntervalMs: 0 });
    const calls: string[] = [];
    const logs: string[] = [];
    c.on('log', (msg) => logs.push(msg));
    (c as unknown as { getJson(url: string, init?: { body?: string }): Promise<unknown> }).getJson = async (url, init) => {
      const smpRead = url.includes('getMarketPrices');
      calls.push(smpRead ? 'smp' : 'page');
      const data = smpRead ? smp(JSON.parse(init?.body ?? '{}').marketIds as string[]) : page;
      if (data instanceof Error) throw data;
      return { data, headers: new Headers(), sentAt: Date.now(), receivedAt: Date.now() };
    };
    return { c, calls, logs };
  }

  it('re-reads a tab’s markets at most every 30 s, and prices only that tab’s group from SMP on every read', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-23T18:00:00Z'), toFake: ['Date'] });
    const priced: string[][] = [];
    const { c, calls } = connector((ids) => (priced.push(ids), smpAll('receiving')));
    // Rush + receiving yards rides on the receiving tab, but it is a rushing stat: not priced or returned here.
    expect((await c.fetchProps(FD_GAME, 'receiving')).map((p) => p.stat).sort()).toEqual(['rec_yds', 'rec_yds', 'rec_yds', 'receptions', 'receptions']);
    expect(priced[0]).toHaveLength(5);
    vi.setSystemTime(new Date('2026-10-23T18:00:20Z'));
    await c.fetchProps(FD_GAME, 'receiving');
    expect(calls).toEqual(['page', 'smp', 'smp']);
    vi.setSystemTime(new Date('2026-10-23T18:00:31Z'));
    await c.fetchProps(FD_GAME, 'receiving');
    expect(calls).toEqual(['page', 'smp', 'smp', 'page', 'smp']);
  });

  it('fails the read when SMP can’t price the markets: the CDN-cached page is never used for prices', async () => {
    // An empty answer is a failed read, not every market closed.
    await expect(connector(() => []).c.fetchProps(FD_GAME, 'receiving')).rejects.toThrow(/SMP returned no markets/);
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    await expect(connector(() => timeout).c.fetchProps(FD_GAME, 'receiving')).rejects.toBe(timeout);
  });

  it('fails the read when SMP refuses us, so the props service backs off the host the main-line poll uses', async () => {
    const refused = new HttpError(403, 'https://smp.nj.sportsbook.fanduel.com/x', 'Forbidden');
    await expect(connector(() => refused).c.fetchProps(FD_GAME, 'receiving')).rejects.toBe(refused);
  });

  it('says so when a tab lists player props of no type it reads (FD renamed them), rather than showing "none posted"', async () => {
    const page = fixture('fd-event-receiving.json');
    for (const m of Object.values(page.attachments.markets as Record<string, { marketType: string }>)) m.marketType = m.marketType.replace('RECEIVING_YARDS', 'RECEIVING_YDS').replace('RECEPTIONS', 'CATCHES');
    const { c, calls, logs } = connector(() => smpAll('receiving'), page);
    expect(await c.fetchProps(FD_GAME, 'receiving')).toEqual([]);
    expect(calls).toEqual(['page']); // nothing to price
    expect(logs.some((l) => /none of a type we read \(PLAYER_X_RECEIVING_YDS/.test(l))).toBe(true);
  });
});

describe('lining the books up', () => {
  const rows = mergeProps([
    { book: 'draftkings', props: dk('receiving') },
    { book: 'fanduel', props: fd('receiving') },
  ]);
  const row = (stat: string, name: string) => rows.find((r) => r.stat === stat && r.name === name)!;

  it('one row per stat and player, each book’s offer side by side, named as the first book writes it', () => {
    const barner = row('receptions', 'A.J. Barner');
    expect(barner.team).toBe('home');
    expect(barner.offers).toEqual({
      draftkings: { line: 2.5, prices: { over: -142, under: 111 }, suspended: false },
      fanduel: { line: 2.5, prices: { over: -158, under: 118 }, suspended: false },
    });
  });

  it('stars the better price by the board’s rules: same line by payout, different lines by line, ties to every book', () => {
    // Same line: DK pays more on both sides.
    expect(row('rec_yds', 'Travis Kelce').best).toEqual({ over: { books: ['draftkings'], exact: true }, under: { books: ['draftkings'], exact: true } });
    // 94.5 at DK vs 92.5 at FD: the lower line for the over, the higher one for the under (R4, "by line").
    expect(row('rec_yds', 'Jaxon Smith-Njigba').best).toEqual({ over: { books: ['fanduel'], exact: false }, under: { books: ['draftkings'], exact: false } });
    // −160 at both books.
    expect(row('receptions', 'Kenneth Walker III').best.under).toEqual({ books: ['draftkings', 'fanduel'], exact: true });
    // Only DK offers Kelce's longest reception: nothing was compared, so no star.
    expect(row('rec_long', 'Travis Kelce').best).toEqual({});
  });

  it('scorer prices compare by payout; suspended offers are shown but never best', () => {
    const td = mergeProps([
      { book: 'draftkings', props: dk('td') },
      { book: 'fanduel', props: fd('td').map((p) => (p.player === 'Travis Kelce' ? { ...p, suspended: true } : p)) },
    ]);
    const anytime = (name: string) => td.find((r) => r.stat === 'td_anytime' && r.name === name)!;
    expect(anytime('Kenneth Walker III').best.yes).toEqual({ books: ['fanduel'], exact: true }); // −125 beats −130
    expect(anytime('Travis Kelce').offers.fanduel?.suspended).toBe(true);
    expect(anytime('Travis Kelce').best).toEqual({}); // DK's +215 has nothing unsuspended to beat
  });

  it('orders by stat, then the starters (biggest line) or the favorites (shortest price) first', () => {
    expect(rows.filter((r) => r.stat === 'rec_yds').map((r) => r.name)).toEqual(['Jaxon Smith-Njigba', 'Xavier Worthy', 'Travis Kelce']);
    const td = mergeProps([{ book: 'fanduel', props: fd('td') }]).filter((r) => r.stat === 'td_anytime');
    expect(td.map((r) => r.name)).toEqual(['Kenneth Walker III', 'Jaxon Smith-Njigba', 'Zach Charbonnet', 'Travis Kelce']);
  });

  it('drops prices that are not usable American odds, as the board does', () => {
    const merged = mergeProps([{ book: 'fanduel', props: [{ stat: 'rec_yds', player: 'X', team: null, line: 40.5, prices: { over: 50, under: -110 }, suspended: false }] }]);
    expect(merged[0]?.offers.fanduel?.prices).toEqual({ under: -110 });
  });
});

describe('PropsService', () => {
  function harness(readers: Partial<Record<BookId, PropsReader>>, opts: Partial<PropsOptions> = {}) {
    let now = 1_000_000;
    const games: Partial<Record<BookId, BookGame>> = { draftkings: game('draftkings', '34118035'), fanduel: FD_GAME };
    const svc = new PropsService({ books: ['draftkings', 'fanduel'], games: (g) => (g === GAME ? games : null), readers, ttlMs: 10_000, now: () => now, ...opts });
    return {
      svc,
      games,
      advance: (ms: number) => {
        now += ms;
      },
      get: async () => (await svc.get(GAME, 'receiving'))!,
    };
  }
  const book = (res: PropsResponse, id: BookId) => res.books.find((b) => b.book === id)!;

  it('reads each book for the requested group, with the board’s view of the game, and keeps another group’s stat off the tab', async () => {
    const dkRead = vi.fn<PropsReader>(async () => dk('receiving'));
    const fdRead = vi.fn<PropsReader>(async () => fd('receiving'));
    const { get, games } = harness({ draftkings: dkRead, fanduel: fdRead });
    const res = await get();
    expect(dkRead).toHaveBeenCalledWith(games.draftkings, 'receiving');
    expect(fdRead).toHaveBeenCalledWith(games.fanduel, 'receiving');
    expect(res.books).toEqual([
      { book: 'draftkings', state: 'ok', detail: null, fetchedAt: 1_000_000 },
      { book: 'fanduel', state: 'ok', detail: null, fetchedAt: 1_000_000 },
    ]);
    expect(res.rows.every((r) => PROP_STATS[r.stat].group === 'receiving')).toBe(true);
    expect(res.rows.map((r) => r.stat)).not.toContain('rush_rec_yds');
    expect(res.rows).toHaveLength(6);
  });

  it('is null for a game that is not on the board, and reads nothing', async () => {
    const dkRead = vi.fn<PropsReader>(async () => []);
    const { svc } = harness({ draftkings: dkRead });
    expect(await svc.get('2026-10-25:AAA@BBB', 'passing')).toBeNull();
    expect(dkRead).not.toHaveBeenCalled();
  });

  it('shares one read between concurrent viewers and for the TTL, then reads again; the merge is reused meanwhile', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fdRead = vi.fn<PropsReader>(async () => {
      await gate;
      return fd('receiving');
    });
    const { svc, get, advance } = harness({ fanduel: fdRead });
    const both = Promise.all([get(), get()]);
    release();
    const [a, b] = await both;
    expect(fdRead).toHaveBeenCalledTimes(1);
    expect(svc.counters).toMatchObject({ reads: 1, joined: 1 });
    // Nothing new to merge: both viewers get the same rows.
    expect(a.rows).toBe(b.rows);
    advance(9_000);
    expect((await get()).rows).toBe(a.rows);
    expect(fdRead).toHaveBeenCalledTimes(1);
    advance(1_000);
    const fresh = await get();
    expect(fdRead).toHaveBeenCalledTimes(2);
    expect(fresh.rows).not.toBe(a.rows);
    expect(fresh.rows).toEqual(a.rows);
  });

  it('looks again only after a minute when a book has no props posted yet', async () => {
    const dkRead = vi.fn<PropsReader>(async () => []);
    const { get, advance } = harness({ draftkings: dkRead });
    await get();
    advance(30_000);
    await get();
    expect(dkRead).toHaveBeenCalledTimes(1);
    advance(30_000);
    await get();
    expect(dkRead).toHaveBeenCalledTimes(2);
  });

  it('keeps a failing book to itself: the other still shows, and the last good props stay while recent', async () => {
    let fail = false;
    const dkRead = vi.fn<PropsReader>(async () => {
      if (fail) throw new Error('socket hang up');
      return dk('receiving');
    });
    const { get, advance } = harness({ draftkings: dkRead, fanduel: async () => fd('receiving') }, { maxAgeMs: 60_000 });
    await get();
    fail = true;
    advance(10_000);
    let res = await get();
    expect(book(res, 'draftkings')).toEqual({ book: 'draftkings', state: 'error', detail: 'socket hang up', fetchedAt: 1_000_000 });
    expect(book(res, 'fanduel').state).toBe('ok');
    const kelce = res.rows.find((r) => r.name === 'Travis Kelce' && r.stat === 'rec_yds')!;
    expect(kelce.offers.draftkings).toBeDefined();
    // DK's −111 beat FD's −114 while DK was current; its last read is shown but can't be best, as on the board.
    expect(kelce.best).toEqual({});
    advance(51_000); // past maxAge since the last good read
    res = await get();
    expect(book(res, 'draftkings')).toMatchObject({ state: 'error', fetchedAt: null });
    expect(res.rows.some((r) => r.offers.draftkings !== undefined)).toBe(false);
  });

  it('backs off a book that refuses reads (401/403/429): a minute, then doubling, and says so', async () => {
    const dkRead = vi.fn<PropsReader>(async () => {
      throw new HttpError(403, 'https://sportsbook-nash.draftkings.com/x', '<HTML>Access Denied</HTML>');
    });
    const { get, advance } = harness({ draftkings: dkRead });
    expect(book(await get(), 'draftkings')).toMatchObject({ state: 'error', detail: 'HTTP 403, refused by the book' });
    advance(10_000);
    expect(book(await get(), 'draftkings').detail).toBe('refused by the book; retrying in 50s');
    expect(dkRead).toHaveBeenCalledTimes(1);
    advance(50_000);
    await get(); // refused again: two minutes this time
    expect(dkRead).toHaveBeenCalledTimes(2);
    advance(110_000);
    expect(book(await get(), 'draftkings').detail).toBe('refused by the book; retrying in 10s');
    advance(10_000);
    await get();
    expect(dkRead).toHaveBeenCalledTimes(3);
  });

  it('times the next read from when a read lands, so a slow read isn’t followed straight away by another', async () => {
    let release!: (props: BookProp[]) => void;
    const gate = new Promise<BookProp[]>((r) => (release = r));
    const fdRead = vi.fn<PropsReader>(() => gate);
    const { get, advance } = harness({ fanduel: fdRead });
    const first = get();
    await vi.waitFor(() => expect(fdRead).toHaveBeenCalledTimes(1));
    advance(15_000); // the read takes 15 s, past the 10 s TTL
    release(fd('receiving'));
    await first;
    advance(5_000);
    await get();
    expect(fdRead).toHaveBeenCalledTimes(1);
    advance(5_000);
    await get();
    expect(fdRead).toHaveBeenCalledTimes(2);
  });

  it('answers from the last good read when a refresh is slow, instead of holding the response for the slowest book', async () => {
    let slow = false;
    const dkRead = vi.fn<PropsReader>(async () => (slow ? new Promise<BookProp[]>(() => {}) : dk('receiving')));
    const { get, advance } = harness({ draftkings: dkRead, fanduel: async () => fd('receiving') }, { readWaitMs: 20 });
    await get();
    slow = true;
    advance(10_000);
    const started = Date.now();
    const res = await get();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(book(res, 'draftkings')).toEqual({ book: 'draftkings', state: 'ok', detail: null, fetchedAt: 1_000_000 });
    expect(res.rows.some((r) => r.offers.draftkings !== undefined)).toBe(true);
  });

  it('after good props, an empty read is checked again on the usual schedule, not after a minute', async () => {
    let props = dk('receiving');
    const dkRead = vi.fn<PropsReader>(async () => props);
    const { get, advance } = harness({ draftkings: dkRead });
    await get();
    props = [];
    advance(10_000);
    await get();
    advance(10_000);
    await get();
    expect(dkRead).toHaveBeenCalledTimes(3);
  });

  it('keeps showing the last good props for at least two TTLs, whatever maxAgeMs says', async () => {
    let fail = false;
    const { get, advance } = harness({ draftkings: async () => (fail ? Promise.reject(new Error('down')) : dk('receiving')) }, { ttlMs: 100_000, maxAgeMs: 60_000 });
    await get();
    fail = true;
    advance(150_000);
    expect(book(await get(), 'draftkings')).toMatchObject({ state: 'error', fetchedAt: 1_000_000 });
  });

  it('describes a body that isn’t JSON as unreadable, not as "HTTP 200"', async () => {
    const { get } = harness({ fanduel: () => Promise.reject(new HttpError(200, 'https://sbapi.nj.sportsbook.fanduel.com/x', 'unparseable JSON: <html>')) });
    expect(book(await get(), 'fanduel').detail).toBe('unreadable answer');
  });

  it('says why a book has no props: no reader, its feed is down, or it doesn’t list the game', async () => {
    let down = true;
    const h = harness({ fanduel: async () => [], draftkings: async () => [] }, { bookDown: (b) => b === 'draftkings' && down });
    delete h.games.draftkings;
    delete h.games.fanduel;
    expect((await h.get()).books.map((b) => b.state)).toEqual(['down', 'unlisted']);
    down = false;
    expect((await h.get()).books.map((b) => b.state)).toEqual(['unlisted', 'unlisted']);
    const noReader = harness({ fanduel: async () => [] });
    expect(book(await noReader.get(), 'draftkings').state).toBe('unsupported');
  });

  it('describes a timeout in words', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { get } = harness({ fanduel: () => Promise.reject(timeout) });
    expect(book(await get(), 'fanduel').detail).toBe('timed out');
  });
});

describe('synthetic props (BOOKS=fake)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists props for any game the board hands it: some on both books, some on one', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-23T18:00:00Z'), toFake: ['Date'] });
    const dkFake = new FakeConnector(BOOKS.draftkings, { seed: 7 });
    const fdFake = new FakeConnector(BOOKS.fanduel, { seed: 7 });
    const [dkProps, fdProps] = await Promise.all([dkFake.fetchProps(game('draftkings', 'fake-1'), 'touchdowns'), fdFake.fetchProps(game('fanduel', 'fake-1'), 'touchdowns')]);
    expect(dkProps.length).toBeGreaterThan(0);
    expect([...dkProps, ...fdProps].every((p) => PROP_STATS[p.stat].group === 'touchdowns' && p.prices.yes !== undefined)).toBe(true);
    expect(dkProps.map((p) => p.player)).toContain('Chiefs QB');
    const rows = mergeProps([
      { book: 'draftkings', props: dkProps },
      { book: 'fanduel', props: fdProps },
    ]);
    expect(rows.some((r) => Object.keys(r.offers).length === 2)).toBe(true);
    expect(rows.some((r) => Object.keys(r.offers).length === 1)).toBe(true);
  });
});

describe('GET /api/games/:game/props', () => {
  let app: FastifyInstance;
  let hub: SseHub;
  const response: PropsResponse = { game: GAME, group: 'rushing', ts: 1, books: [], rows: [] };
  const get = vi.fn(async (game: string) => (game === GAME ? response : null));

  beforeAll(async () => {
    const board = new Board({ books: [BOOKS.draftkings, BOOKS.fanduel], staleGraceMs: 5_000 });
    hub = new SseHub(board);
    const counters = { reads: 3, failures: 0, joined: 1 };
    app = await buildApp({ board, hub, latency: new LatencyTracker(), props: { get, counters }, cfg: { logLevel: 'error', chaos: false, webDir: '/nonexistent' }, logger: false });
  });

  afterAll(async () => {
    hub.close();
    await app.close();
  });

  it('answers one group of one game, never browser-cached', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/games/${encodeURIComponent(GAME)}/props?group=rushing` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.json()).toEqual(response);
    expect(get).toHaveBeenLastCalledWith(GAME, 'rushing');
  });

  it('defaults to the first group, and refuses an unknown one', async () => {
    await app.inject({ method: 'GET', url: `/api/games/${encodeURIComponent(GAME)}/props` });
    expect(get).toHaveBeenLastCalledWith(GAME, 'passing');
    const bad = await app.inject({ method: 'GET', url: `/api/games/${encodeURIComponent(GAME)}/props?group=kicking` });
    expect(bad.statusCode).toBe(400);
  });

  it('is a 404 for a game that is not on the board', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/games/2026-10-25%3AAAA%40BBB/props' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'game not on the board' });
  });

  it('reports the props counters in /api/metrics', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/metrics' });
    expect(res.json().props).toEqual({ reads: 3, failures: 0, joined: 1 });
  });
});
