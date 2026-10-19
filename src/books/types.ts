import { EventEmitter } from 'node:events';
import { MARKET_SIDES, type BookId, type Channel, type ConnectionState, type MarketType, type Side } from '../shared/domain.js';

// The primitive unions live in src/shared/domain.ts so the browser can use them without node:events.
export type { BookId, Channel, ConnectionState, MarketType, Side };

/** A game as one book lists it, keyed by a cross-book `gameKey` so books line up. */
export interface BookGame {
  book: BookId;
  gameKey: string;
  bookEventId: string;
  away: string; // canonical team code, e.g. "WAS"
  home: string;
  startTime: string; // ISO-8601 UTC
  live: boolean;
}

/** One side of one main-line market at one book. Identity: (book, gameKey, market, side). */
export interface Quote {
  book: BookId;
  gameKey: string;
  market: MarketType;
  side: Side;
  /** Spread for this side (e.g. -7.5) or the total (e.g. 51.5); null for moneyline. */
  line: number | null;
  american: number;
  decimal: number;
  suspended: boolean;
  live: boolean;
  /** Epoch ms the book stamped this change, when the feed exposes one (DK createdTime, FD updatedAt). */
  bookTime: number | null;
  /** Epoch ms our process received the message carrying this value. */
  receivedAt: number;
  channel: Channel;
}

/**
 * One channel observing a new state for one quote, emitted before cross-channel dedupe, so latency
 * can be measured per channel (push vs poll vs snapshot) without bias toward whichever channel won.
 * Each channel emits a sample only when its own view of the quote changes.
 */
export interface QuoteSample {
  book: BookId;
  gameKey: string;
  market: MarketType;
  side: Side;
  channel: Channel;
  line: number | null;
  american: number;
  suspended: boolean;
  live: boolean;
  /** The book's own change time when exposed: DK `createdTime` (ms), FD PIR `updatedAt` (whole seconds). */
  bookTime: number | null;
  /** DK only: when DK's pipeline published the frame (`metadata.publishedTime`). */
  publishedAt: number | null;
  /** DK only: when DK's socket gateway sent the frame (`websocketPublishTimestamp`). */
  gatewayAt: number | null;
  receivedAt: number;
  /** False when the channel's observation lost to a fresher one from another channel (e.g. a stale poll). */
  applied: boolean;
}

export interface QuoteRef {
  gameKey: string;
  market: MarketType;
  side: Side;
}

export interface BookStatus {
  book: BookId;
  state: ConnectionState;
  detail: string | null;
  /** Last time the book proved our view is current: any frame, keepalive, pong or successful poll. */
  lastDataAt: number | null;
  /** Last time a price, line or status actually changed. */
  lastChangeAt: number | null;
  since: number;
}

/** A batch of normalized changes produced by one inbound message or snapshot. */
export interface BookChange {
  book: BookId;
  games: BookGame[];
  removedGames: string[];
  quotes: Quote[];
  removedQuotes: QuoteRef[];
}

export interface BookSnapshot {
  games: BookGame[];
  quotes: Quote[];
  status: BookStatus;
}

export const quoteKey = (q: QuoteRef): string => `${q.gameKey}|${q.market}|${q.side}`;

/** Every quote slot a market of this type can hold. */
export const quoteRefsFor = (gameKey: string, market: MarketType): QuoteRef[] => MARKET_SIDES[market].map((side) => ({ gameKey, market, side }));

interface ConnectorEvents {
  change: [BookChange];
  sample: [QuoteSample[]];
  status: [BookStatus];
  log: [string];
}

/**
 * Base class for a sportsbook connector: one long-lived ingestion per book that emits
 * normalized `change` batches. Subclasses only translate their feed into `BookGame`/`Quote`
 * objects and call `commit`; diffing, state and status bookkeeping live here, so adding a
 * book means writing a translator, not touching the consumers.
 */
export abstract class BookConnector extends EventEmitter<ConnectorEvents> {
  abstract readonly book: BookId;
  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  private readonly gameState = new Map<string, BookGame>();
  private readonly quoteState = new Map<string, Quote>();
  private readonly sampleState = new Map<string, string>();
  private statusState: BookStatus | null = null;
  /** Listener exceptions caught by `dispatch`; a consumer bug must never take ingestion down. */
  listenerErrors = 0;

  get status(): BookStatus {
    this.statusState ??= { book: this.book, state: 'stopped', detail: null, lastDataAt: null, lastChangeAt: null, since: Date.now() };
    return this.statusState;
  }

  snapshot(): BookSnapshot {
    return { games: [...this.gameState.values()], quotes: [...this.quoteState.values()], status: this.status };
  }

  protected setStatus(state: ConnectionState, detail: string | null = null): void {
    const prev = this.status;
    if (prev.state === state && prev.detail === detail) return;
    this.statusState = { ...prev, state, detail, since: prev.state === state ? prev.since : Date.now() };
    this.dispatch('status', this.statusState);
  }

  /** Record liveness without emitting: `status.lastDataAt` advances silently, and consumers read it on their own schedule. */
  protected touch(at = Date.now()): void {
    this.statusState = { ...this.status, lastDataAt: at };
  }

  protected log(msg: string): void {
    this.dispatch('log', `[${this.book}] ${msg}`);
  }

  /**
   * Emit to each listener in isolation. Connectors emit from inside socket and poll handlers, so a
   * throwing listener would otherwise unwind into `ws`/`undici` and crash the process (and stop
   * the remaining listeners from running).
   */
  protected dispatch<K extends keyof ConnectorEvents>(event: K, ...args: ConnectorEvents[K]): void {
    for (const listener of this.rawListeners(event) as ((...a: ConnectorEvents[K]) => void)[]) {
      try {
        listener(...args);
      } catch (err) {
        this.listenerErrors++;
        console.error(`[${this.book}] ${String(event)} listener threw (${this.listenerErrors} so far):`, err);
      }
    }
  }

  /**
   * Report what one channel just observed, before cross-channel dedupe. Only states that are new
   * for that channel are emitted, so a 1 s poll of an unchanged board costs nothing downstream.
   */
  protected emitSamples(
    quotes: Quote[],
    applied: boolean,
    extra: { publishedAt?: number | null; gatewayAt?: number | null } = {},
  ): void {
    if (!quotes.length || this.listenerCount('sample') === 0) return;
    const out: QuoteSample[] = [];
    for (const q of quotes) {
      const key = `${q.channel}|${quoteKey(q)}`;
      const state = `${q.line}|${q.american}|${q.suspended}|${q.live}`;
      if (this.sampleState.get(key) === state) continue;
      this.sampleState.set(key, state);
      out.push({
        book: q.book,
        gameKey: q.gameKey,
        market: q.market,
        side: q.side,
        channel: q.channel,
        line: q.line,
        american: q.american,
        suspended: q.suspended,
        live: q.live,
        bookTime: q.bookTime,
        publishedAt: extra.publishedAt ?? null,
        gatewayAt: extra.gatewayAt ?? null,
        receivedAt: q.receivedAt,
        applied,
      });
    }
    if (out.length) this.dispatch('sample', out);
  }

  /**
   * Diff the proposed games/quotes against current state and emit only real changes.
   * Price identity is (american, line, suspended, live); decimal precision differences
   * between channels (e.g. FD SMP vs PIR) do not count as moves.
   */
  protected commit(input: { games?: BookGame[]; removedGames?: string[]; quotes?: Quote[]; removedQuotes?: QuoteRef[] }): BookChange {
    const out: BookChange = { book: this.book, games: [], removedGames: [], quotes: [], removedQuotes: [] };

    for (const g of input.games ?? []) {
      const prev = this.gameState.get(g.gameKey);
      if (!prev || prev.live !== g.live || prev.startTime !== g.startTime || prev.bookEventId !== g.bookEventId) {
        this.gameState.set(g.gameKey, g);
        out.games.push(g);
      }
    }
    for (const q of input.quotes ?? []) {
      const key = quoteKey(q);
      const prev = this.quoteState.get(key);
      if (!prev || prev.american !== q.american || prev.line !== q.line || prev.suspended !== q.suspended || prev.live !== q.live) {
        this.quoteState.set(key, q);
        out.quotes.push(q);
      }
    }
    for (const ref of input.removedQuotes ?? []) {
      if (this.quoteState.delete(quoteKey(ref))) out.removedQuotes.push(ref);
    }
    for (const gameKey of input.removedGames ?? []) {
      if (!this.gameState.delete(gameKey)) continue;
      out.removedGames.push(gameKey);
      for (const [key, q] of this.quoteState) {
        if (q.gameKey === gameKey) {
          this.quoteState.delete(key);
          out.removedQuotes.push({ gameKey, market: q.market, side: q.side });
        }
      }
    }

    if (out.games.length || out.removedGames.length || out.quotes.length || out.removedQuotes.length) {
      if (out.quotes.length || out.removedQuotes.length) this.statusState = { ...this.status, lastChangeAt: Date.now() };
      this.dispatch('change', out);
    }
    return out;
  }

  protected hasQuote(ref: QuoteRef): boolean {
    return this.quoteState.has(quoteKey(ref));
  }

  protected currentQuotes(): IterableIterator<Quote> {
    return this.quoteState.values();
  }

  protected currentGames(): IterableIterator<BookGame> {
    return this.gameState.values();
  }
}
