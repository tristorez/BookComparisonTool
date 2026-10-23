import type { BookId } from '@shared/domain';
import type { PropGroup } from '@shared/props';
import type {
  Delta,
  Heartbeat,
  PropsResponse,
  Snapshot,
  WireBestNone,
  WireBestPick,
  WireBookMeta,
  WireBookStatus,
  WireGame,
  WirePropRow,
  WirePropsBook,
  WireQuote,
} from '@shared/wire';
import { PropsClient } from '../lib/props';
import { OddsStore, type StoreOptions } from '../lib/store';
import type { EventSourceLike } from '../lib/stream';

export const GAME = '2026-10-25:PIT@NO';
export const BOOT = 'b1';

export const BOOKS: WireBookMeta[] = [
  { id: 'draftkings', name: 'DraftKings', short: 'DK', color: '#53d337' },
  { id: 'fanduel', name: 'FanDuel', short: 'FD', color: '#1493ff' },
];

export function game(over: Partial<WireGame> = {}): WireGame {
  return {
    key: GAME,
    away: 'PIT',
    home: 'NO',
    awayName: 'Pittsburgh Steelers',
    homeName: 'New Orleans Saints',
    start: '2026-10-25T17:00:00.000Z',
    live: false,
    books: ['draftkings', 'fanduel'],
    ...over,
  };
}

/** Spread, home side, −3 −110 unless overridden. */
export function quote(book: BookId, over: Partial<WireQuote> = {}): WireQuote {
  return {
    book,
    game: GAME,
    market: 'spread',
    side: 'home',
    line: -3,
    american: -110,
    suspended: false,
    live: false,
    bt: null,
    rx: 1_000,
    ch: 'push',
    feed: 'A',
    ...over,
  };
}

export function pick(over: Partial<WireBestPick> = {}): WireBestPick {
  return {
    game: GAME,
    market: 'spread',
    side: 'home',
    books: ['draftkings'],
    line: -3,
    american: -110,
    exact: true,
    rule: 'R2',
    reason: '',
    cause: 'price',
    ...over,
  };
}

export function none(over: Partial<WireBestNone> = {}): WireBestNone {
  return { game: GAME, market: 'spread', side: 'home', none: true, cause: 'eligibility', ...over };
}

export function status(book: BookId, over: Partial<WireBookStatus> = {}): WireBookStatus {
  return {
    book,
    state: 'live',
    stale: false,
    detail: null,
    lastDataAt: 1_000,
    lastChangeAt: 1_000,
    feeds: [
      { id: 'A', state: 'live', stale: false, detail: null, lastDataAt: 1_000 },
      { id: 'B', state: 'live', stale: false, detail: null, lastDataAt: 1_000 },
    ],
    ...over,
  };
}

export function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    boot: BOOT,
    seq: 10,
    ts: 1_000,
    books: BOOKS,
    status: [status('draftkings'), status('fanduel')],
    games: [game()],
    quotes: [],
    bests: [],
    ...over,
  };
}

export function delta(seq: number, over: Partial<Delta> = {}): Delta {
  return { seq, ts: 2_000, ...over };
}

export function heartbeat(seq: number, over: Partial<Heartbeat> = {}): Heartbeat {
  return { boot: BOOT, seq, ts: 2_000, status: [status('draftkings'), status('fanduel')], ...over };
}

/** A store whose notifications are flushed by hand (`store.flush()`), with no disconnect grace. */
export function manualStore(opts: StoreOptions = {}): OddsStore {
  return new OddsStore({ schedule: () => {}, disconnectGraceMs: 0, ...opts });
}

/** Every registry book read its props fine at `fetchedAt`. */
export function propsBooks(fetchedAt = Date.now()): WirePropsBook[] {
  return BOOKS.map((b) => ({ book: b.id, state: 'ok', detail: null, fetchedAt }));
}

export function propsResponse(group: PropGroup, rows: WirePropRow[] = [], over: Partial<PropsResponse> = {}): PropsResponse {
  return { game: GAME, group, ts: Date.now(), books: propsBooks(), rows, ...over };
}

/**
 * A props client whose server answers each request with `answer(group)`: a response, or an HTTP status
 * for a failure. `calls` lists the URLs requested. Pass a short `refreshMs` to see it re-read.
 */
export function propsClient(answer: (group: PropGroup) => PropsResponse | number, refreshMs?: number): PropsClient & { calls: string[] } {
  const calls: string[] = [];
  const client = new PropsClient({
    refreshMs,
    fetch: async (url) => {
      calls.push(url);
      const body = answer((new URL(url, 'http://x').searchParams.get('group') ?? 'passing') as PropGroup);
      return typeof body === 'number' ? { ok: false, status: body, json: async () => ({}) } : { ok: true, status: 200, json: async () => body };
    },
  });
  return Object.assign(client, { calls });
}

/** A props client that never answers: the props section stays loading. */
export function idleProps(): PropsClient {
  return new PropsClient({ fetch: () => new Promise(() => {}) });
}

/** Drives the client the way a browser EventSource would. */
export class FakeEventSource implements EventSourceLike {
  readyState = 0;
  closed = false;
  private readonly listeners = new Map<string, Array<(ev: Event) => void>>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (ev: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.readyState = 2;
    this.closed = true;
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open', new Event('open'));
  }

  emit(type: 'snapshot' | 'delta' | 'hb', data: unknown, id = ''): void {
    this.dispatch(type, new MessageEvent(type, { data: JSON.stringify(data), lastEventId: id }));
  }

  /** `closed: true` = the browser gave up (readyState CLOSED); otherwise it is retrying (CONNECTING). */
  fail(closed = false): void {
    this.readyState = closed ? 2 : 0;
    this.dispatch('error', new Event('error'));
  }

  private dispatch(type: string, ev: Event): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

export function fakeEventSources(): { created: FakeEventSource[]; factory: (url: string) => FakeEventSource; last: () => FakeEventSource } {
  const created: FakeEventSource[] = [];
  return {
    created,
    factory: (url) => {
      const es = new FakeEventSource(url);
      created.push(es);
      return es;
    },
    last: () => {
      const es = created[created.length - 1];
      if (es === undefined) throw new Error('no EventSource created yet');
      return es;
    },
  };
}
