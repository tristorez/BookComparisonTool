import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { BookId, MarketType, Side } from '@shared/domain';
import type {
  Delta,
  GameKey,
  Snapshot,
  WireBest,
  WireBestPick,
  WireBookMeta,
  WireBookStatus,
  WireGame,
  WireQuote,
} from '@shared/wire';
import type { Eligibility } from './eligibility';
import { etDateKey, formatEtDateLabel } from './format';
import { compareForBettor, type PricePoint } from './odds';
import { cellKey, quoteKey } from './shared';

export type ConnState = 'connecting' | 'open' | 'reconnecting';

/**
 * A price move the browser saw happen. Drives the flash and the struck-through previous price.
 * Only live deltas create one: never a snapshot, a resume replay, a hidden tab or an eligibility change.
 */
export interface Move {
  /** Store-wide and monotonic. A cell flashes only for a move numbered above the one it mounted with. */
  n: number;
  /** `up` = better for the bettor. */
  dir: 'up' | 'down';
  prevLine: number | null;
  prevAmerican: number;
  /** Local `Date.now()` when the move was applied (the previous price shows for 5 s from here). */
  at: number;
}

export interface CellState {
  readonly best: WireBest | undefined;
  /** Move of the displayed best value (Best view). */
  readonly move: Move | undefined;
}

export interface QuoteState {
  readonly quote: WireQuote | undefined;
  /** Move of this book's quote (book views). */
  readonly move: Move | undefined;
}

export interface ConnectionInfo {
  readonly state: ConnState;
  /** Local time of the last frame received while in sync; null before the first one. */
  readonly lastFrameAt: number | null;
  /** Local time this state was entered. */
  readonly since: number;
}

export interface GameGroup {
  /** "live" or the ET date, e.g. "2026-10-25". */
  readonly id: string;
  readonly label: string;
  readonly live: boolean;
  readonly games: readonly WireGame[];
}

export interface StoreOptions {
  /** How a notification flush is scheduled. Default: the next animation frame. */
  schedule?: (flush: () => void) => void;
  now?: () => number;
  /**
   * How long the stream may be reconnecting before the whole board is shown stale. The header's
   * connection indicator flips at once; this only spares the board a flash of hatching during a
   * sub-second resume.
   */
  disconnectGraceMs?: number;
}

export const isPick = (b: WireBest | undefined): b is WireBestPick => b !== undefined && b.none !== true;

const EMPTY_CELL: CellState = Object.freeze({ best: undefined, move: undefined });
const EMPTY_QUOTE: QuoteState = Object.freeze({ quote: undefined, move: undefined });
const NO_BOOKS: readonly WireBookMeta[] = Object.freeze([]);
const NO_GROUPS: readonly GameGroup[] = Object.freeze([]);

const TOPIC_GAMES = 'games';
const TOPIC_BOOKS = 'books';
const TOPIC_STATUS = 'status';
const TOPIC_CONN = 'conn';
const TOPIC_ELIG = 'elig';
const cellTopic = (key: string): string => `cell:${key}`;
const quoteTopic = (key: string): string => `quote:${key}`;

/** Subscription topics (what each hook listens to). */
export const TOPICS = {
  games: TOPIC_GAMES,
  books: TOPIC_BOOKS,
  status: TOPIC_STATUS,
  connection: TOPIC_CONN,
  eligibility: TOPIC_ELIG,
  cell: cellTopic,
  quote: quoteTopic,
} as const;

function defaultSchedule(flush: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => flush());
  else setTimeout(flush, 16);
}

/**
 * The browser's copy of the board. Writes (from the stream) apply immediately; subscribers are told at
 * most once per animation frame, and only those whose topic changed, so a burst of deltas costs one
 * render of the cells it touched. Every read returns a cached object that changes identity only when
 * its content does, as `useSyncExternalStore` requires.
 */
export class OddsStore {
  private books: readonly WireBookMeta[] = NO_BOOKS;
  private status: ReadonlyMap<BookId, WireBookStatus> = new Map();
  private games = new Map<GameKey, WireGame>();
  private quotes = new Map<string, QuoteState>();
  private cells = new Map<string, CellState>();
  private quoteCount = new Map<GameKey, number>();
  private groups: readonly GameGroup[] | null = NO_GROUPS;
  private loaded = false;
  private conn: ConnectionInfo;
  private elig: Eligibility = Object.freeze({ disconnected: false, stale: new Set<BookId>() });
  private disconnected = false;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private moveSeq = 0;

  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly dirty = new Set<string>();
  private dirtyAll = false;
  private scheduled = false;
  private afterFlushQueue: Array<() => void> = [];

  private readonly schedule: (flush: () => void) => void;
  private readonly now: () => number;
  private readonly graceMs: number;

  constructor(opts: StoreOptions = {}) {
    this.schedule = opts.schedule ?? defaultSchedule;
    this.now = opts.now ?? (() => Date.now());
    this.graceMs = opts.disconnectGraceMs ?? 2000;
    this.conn = Object.freeze({ state: 'connecting', lastFrameAt: null, since: this.now() });
  }

  // ---- writes -------------------------------------------------------------------------------------

  /** Replaces everything. Clears all moves: nothing flashes or shows a previous price after a snapshot. */
  applySnapshot(s: Snapshot): void {
    if (!sameBooks(this.books, s.books)) this.books = Object.freeze([...s.books]);
    this.status = new Map(s.status.map((x) => [x.book, x]));
    this.games = new Map(s.games.map((g) => [g.key, g]));
    this.quotes = new Map();
    this.quoteCount = new Map();
    for (const q of s.quotes) {
      this.quotes.set(quoteKey(q.book, q.game, q.market, q.side), Object.freeze({ quote: q, move: undefined }));
      this.bump(q.game, 1);
    }
    this.cells = new Map();
    for (const b of s.bests) this.cells.set(cellKey(b.game, b.market, b.side), Object.freeze({ best: b, move: undefined }));
    this.groups = null;
    this.loaded = true;
    this.refreshEligibility();
    this.markAll();
  }

  /**
   * Applies one delta. `live` is true only for deltas that arrived in real time on a visible tab;
   * replayed or background deltas update values silently.
   */
  applyDelta(d: Delta, opts: { live?: boolean } = {}): void {
    const live = opts.live === true;
    let gamesChanged = false;
    for (const g of d.games ?? []) {
      this.games.set(g.key, g);
      gamesChanged = true;
    }
    for (const key of d.removedGames ?? []) {
      if (this.games.delete(key)) gamesChanged = true;
      this.purgeGame(key);
    }
    for (const q of d.quotes ?? []) if (this.putQuote(q, live)) gamesChanged = true;
    for (const k of d.removedQuotes ?? []) if (this.dropQuote(k)) gamesChanged = true;
    for (const b of d.bests ?? []) this.putBest(b, live);
    if (d.status?.length) this.applyStatus(d.status);
    if (gamesChanged) {
      this.groups = null;
      this.mark(TOPIC_GAMES);
    }
  }

  /** Per-book upsert (heartbeats carry every book; deltas only the ones that changed). */
  applyStatus(list: readonly WireBookStatus[]): void {
    if (list.length === 0) return;
    const next = new Map(this.status);
    for (const s of list) next.set(s.book, s);
    this.status = next;
    this.mark(TOPIC_STATUS);
    this.refreshEligibility();
  }

  /** Called by the stream on state transitions, with the time of the last in-sync frame. */
  setConnection(state: ConnState, lastFrameAt: number | null = this.conn.lastFrameAt): void {
    const entered = state !== this.conn.state;
    if (!entered && lastFrameAt === this.conn.lastFrameAt) return;
    this.conn = Object.freeze({ state, lastFrameAt, since: entered ? this.now() : this.conn.since });
    this.mark(TOPIC_CONN);
    if (!entered) return;
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
    this.disconnected = false;
    if (state === 'reconnecting') {
      if (this.graceMs <= 0) {
        this.disconnected = true;
      } else {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = undefined;
          this.disconnected = true;
          this.refreshEligibility();
        }, this.graceMs);
      }
    }
    this.refreshEligibility();
  }

  private putQuote(q: WireQuote, live: boolean): boolean {
    const k = quoteKey(q.book, q.game, q.market, q.side);
    const prior = this.quotes.get(k);
    const old = prior?.quote;
    const moved = q.prev !== undefined && q.prev.at !== old?.prev?.at;
    const valueChanged = old === undefined || old.american !== q.american || old.line !== q.line;
    let move = prior?.move;
    if (moved && live && old !== undefined && q.prev !== undefined) move = this.makeMove(q.market, q.side, q.prev, q);
    else if (moved || valueChanged) move = undefined; // a stale previous price would now be wrong
    this.quotes.set(k, Object.freeze({ quote: q, move }));
    this.mark(quoteTopic(k));
    return old === undefined && this.bump(q.game, 1);
  }

  private dropQuote(k: string): boolean {
    const prior = this.quotes.get(k);
    if (prior === undefined) return false;
    this.quotes.delete(k);
    this.mark(quoteTopic(k));
    return prior.quote !== undefined && this.bump(prior.quote.game, -1);
  }

  private putBest(b: WireBest, live: boolean): void {
    const k = cellKey(b.game, b.market, b.side);
    const prior = this.cells.get(k);
    const old = prior?.best;
    let move = prior?.move;
    if (old === undefined || displayChanged(old, b)) {
      // Flash only a real price move of the displayed value; a book entering or leaving eligibility
      // (`cause: 'eligibility'`) changes the value silently.
      move = live && b.cause === 'price' && isPick(old) && isPick(b) ? this.makeMove(b.market, b.side, old, b) : undefined;
    }
    this.cells.set(k, Object.freeze({ best: b, move }));
    this.mark(cellTopic(k));
  }

  private purgeGame(game: GameKey): void {
    for (const [k, v] of this.quotes) {
      if (v.quote?.game !== game) continue;
      this.quotes.delete(k);
      this.mark(quoteTopic(k));
    }
    for (const [k, v] of this.cells) {
      if (v.best?.game !== game) continue;
      this.cells.delete(k);
      this.mark(cellTopic(k));
    }
    this.quoteCount.delete(game);
  }

  /** Adjusts a game's quote count; true when the game gained its first quote or lost its last. */
  private bump(game: GameKey, by: 1 | -1): boolean {
    const before = this.quoteCount.get(game) ?? 0;
    const after = Math.max(0, before + by);
    if (after === 0) this.quoteCount.delete(game);
    else this.quoteCount.set(game, after);
    return (before === 0) !== (after === 0);
  }

  private makeMove(market: MarketType, side: Side, from: PricePoint, to: PricePoint): Move | undefined {
    const c = compareForBettor(market, side, from, to);
    if (c === 0) return undefined;
    return Object.freeze({
      n: ++this.moveSeq,
      dir: c > 0 ? 'up' : 'down',
      prevLine: from.line,
      prevAmerican: from.american,
      at: this.now(),
    });
  }

  private refreshEligibility(): void {
    const stale = new Set<BookId>();
    for (const s of this.status.values()) if (s.stale) stale.add(s.book);
    const disconnected = this.disconnected && this.loaded;
    if (disconnected === this.elig.disconnected && sameSet(stale, this.elig.stale)) return;
    this.elig = Object.freeze({ disconnected, stale });
    this.mark(TOPIC_ELIG);
  }

  // ---- reads (stable references) --------------------------------------------------------------------

  readonly getBooks = (): readonly WireBookMeta[] => this.books;
  readonly getStatus = (): ReadonlyMap<BookId, WireBookStatus> => this.status;
  readonly getConnection = (): ConnectionInfo => this.conn;
  readonly getEligibility = (): Eligibility => this.elig;
  /** True once a snapshot has been applied. */
  readonly isLoaded = (): boolean => this.loaded;
  /** Games that have at least one quote: live first, then by kickoff, grouped by ET date. */
  readonly getGames = (): readonly GameGroup[] => (this.groups ??= buildGroups(this.games, this.quoteCount));

  getGame(key: GameKey): WireGame | undefined {
    return this.games.get(key);
  }

  getCell(game: GameKey, market: MarketType, side: Side): CellState {
    return this.getCellByKey(cellKey(game, market, side));
  }

  getCellByKey(key: string): CellState {
    return this.cells.get(key) ?? EMPTY_CELL;
  }

  getQuote(book: BookId, game: GameKey, market: MarketType, side: Side): QuoteState {
    return this.getQuoteByKey(quoteKey(book, game, market, side));
  }

  getQuoteByKey(key: string): QuoteState {
    return this.quotes.get(key) ?? EMPTY_QUOTE;
  }

  // ---- subscriptions ----------------------------------------------------------------------------------

  subscribe(topic: string, listener: () => void): () => void {
    let set = this.listeners.get(topic);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(topic);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(topic);
    };
  }

  /** Runs `cb` right after the next notification flush (the frame that renders pending changes). */
  afterFlush(cb: () => void): void {
    this.afterFlushQueue.push(cb);
    this.request();
  }

  /** Notifies every listener whose topic changed since the last flush. */
  readonly flush = (): void => {
    this.scheduled = false;
    const calls: Array<() => void> = [];
    if (this.dirtyAll) {
      for (const set of this.listeners.values()) for (const l of set) calls.push(l);
    } else {
      for (const topic of this.dirty) {
        const set = this.listeners.get(topic);
        if (set !== undefined) for (const l of set) calls.push(l);
      }
    }
    this.dirtyAll = false;
    this.dirty.clear();
    for (const l of calls) l();
    if (this.afterFlushQueue.length > 0) {
      const queue = this.afterFlushQueue;
      this.afterFlushQueue = [];
      for (const cb of queue) cb();
    }
  };

  private mark(topic: string): void {
    if (!this.dirtyAll) this.dirty.add(topic);
    this.request();
  }

  private markAll(): void {
    this.dirtyAll = true;
    this.dirty.clear();
    this.request();
  }

  private request(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(this.flush);
  }
}

function displayChanged(a: WireBest, b: WireBest): boolean {
  if (isPick(a) && isPick(b)) return a.line !== b.line || a.american !== b.american;
  return isPick(a) !== isPick(b);
}

function sameBooks(a: readonly WireBookMeta[], b: readonly WireBookMeta[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => {
      const y = b[i];
      return y !== undefined && x.id === y.id && x.name === y.name && x.short === y.short && x.color === y.color;
    })
  );
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function kickoffMs(g: WireGame): number {
  const t = Date.parse(g.start);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

function compareGames(a: WireGame, b: WireGame): number {
  return kickoffMs(a) - kickoffMs(b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function buildGroups(games: ReadonlyMap<GameKey, WireGame>, counts: ReadonlyMap<GameKey, number>): readonly GameGroup[] {
  const shown = [...games.values()].filter((g) => (counts.get(g.key) ?? 0) > 0).sort(compareGames);
  if (shown.length === 0) return NO_GROUPS;
  const groups: GameGroup[] = [];
  const live = shown.filter((g) => g.live);
  if (live.length > 0) groups.push({ id: 'live', label: 'Live', live: true, games: live });
  let day: { id: string; label: string; live: false; games: WireGame[] } | undefined;
  for (const g of shown) {
    if (g.live) continue;
    const et = etDateKey(g.start);
    const id = et ?? g.key.split(':')[0] ?? g.key;
    if (day === undefined || day.id !== id) {
      day = { id, label: et === null ? id : formatEtDateLabel(g.start), live: false, games: [] };
      groups.push(day);
    }
    day.games.push(g);
  }
  return groups;
}

// ---- React bindings --------------------------------------------------------------------------------

/** The app's store. Tests render with their own through `StoreContext`. */
export const store = new OddsStore();
export const StoreContext = createContext<OddsStore>(store);

export function useStore(): OddsStore {
  return useContext(StoreContext);
}

function useTopic<T>(s: OddsStore, topic: string, read: () => T): T {
  const subscribe = useCallback((cb: () => void) => s.subscribe(topic, cb), [s, topic]);
  return useSyncExternalStore(subscribe, read, read);
}

/** Games with quotes: live first, then by kickoff, grouped by ET date. */
export function useGames(): readonly GameGroup[] {
  const s = useStore();
  return useTopic(s, TOPIC_GAMES, s.getGames);
}

/** True once the first snapshot arrived (distinguishes "connecting" from "no games"). */
export function useLoaded(): boolean {
  const s = useStore();
  return useTopic(s, TOPIC_GAMES, s.isLoaded);
}

/** One game by key: undefined before a snapshot names it, or after it leaves the board. */
export function useGame(key: GameKey): WireGame | undefined {
  const s = useStore();
  return useTopic(s, TOPIC_GAMES, () => s.getGame(key));
}

/** The best pick for one game/market/side, plus the move of its displayed value. */
export function useCell(game: GameKey, market: MarketType, side: Side): CellState {
  const s = useStore();
  const key = cellKey(game, market, side);
  return useTopic(s, cellTopic(key), () => s.getCellByKey(key));
}

/** One book's quote for one game/market/side, plus its move. */
export function useQuote(book: BookId | undefined, game: GameKey, market: MarketType, side: Side): QuoteState {
  const s = useStore();
  const key = book === undefined ? '' : quoteKey(book, game, market, side);
  return useTopic(s, quoteTopic(key), () => (key === '' ? EMPTY_QUOTE : s.getQuoteByKey(key)));
}

export function useBookStatus(): ReadonlyMap<BookId, WireBookStatus> {
  const s = useStore();
  return useTopic(s, TOPIC_STATUS, s.getStatus);
}

/** Book registry from the snapshot: drives the view toggle and status chips (never hard-coded). */
export function useBooks(): readonly WireBookMeta[] {
  const s = useStore();
  return useTopic(s, TOPIC_BOOKS, s.getBooks);
}

export function useConnection(): ConnectionInfo {
  const s = useStore();
  return useTopic(s, TOPIC_CONN, s.getConnection);
}

export function useEligibility(): Eligibility {
  const s = useStore();
  return useTopic(s, TOPIC_ELIG, s.getEligibility);
}

// ---- the shared 1 s clock ----------------------------------------------------------------------------

/** One interval for every "Xs ago" label and previous-price expiry; it runs only while subscribed. */
export class Ticker {
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private current = Date.now();

  readonly read = (): number => this.current;

  readonly subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    if (this.timer === undefined) {
      this.current = Date.now();
      this.timer = setInterval(this.tick, 1000);
    }
    return () => {
      this.listeners.delete(cb);
      if (this.listeners.size === 0 && this.timer !== undefined) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  };

  private readonly tick = (): void => {
    this.current = Date.now();
    for (const l of [...this.listeners]) l();
  };
}

export const ticker = new Ticker();
const noop = (): void => {};
const unsubscribeNoop = (): (() => void) => noop;

/** Local `Date.now()`, refreshed once a second. */
export function useNow(): number {
  return useSyncExternalStore(ticker.subscribe, ticker.read, ticker.read);
}

/**
 * True while less than `windowMs` has passed since local time `at`. Re-renders only when it flips,
 * and subscribes to the ticker only while there is something to expire.
 */
export function useWithin(at: number | undefined, windowMs: number): boolean {
  const subscribe = useCallback(
    (cb: () => void) => (at === undefined ? unsubscribeNoop() : ticker.subscribe(cb)),
    [at],
  );
  const read = (): boolean => at !== undefined && ticker.read() - at < windowMs;
  return useSyncExternalStore(subscribe, read, read);
}
