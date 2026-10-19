/**
 * What the board sends to browsers over SSE (`GET /api/stream`), and what browsers send back.
 *
 * Stream contract (see Decisions.txt D-07):
 * - Events: `snapshot` (id `<boot>.<seq>`), `delta` (id `<boot>.<seq>`), `hb` (no id).
 * - `seq` counts emitted deltas only: consecutive, never skipped. A snapshot carries the head `seq`
 *   it already includes, so the next delta is `seq + 1`.
 * - Per connection the server writes the snapshot (or the replayed deltas) first, then live deltas,
 *   with heartbeats interleaved. A heartbeat's `seq` is never ahead of the deltas already written
 *   to that connection, so `hb.seq > lastApplied` means the client missed something.
 * - Resume: `Last-Event-ID` (automatic reconnects) or `?since=<boot>.<seq>` (a new EventSource).
 *
 * Times are epoch ms. `ts`/`at` use the board's clock; `bt` is the book's own clock; `rx` is the
 * clock of the box that received the value first. All boxes are chrony-synced.
 */
import type { BookId, Channel, ConnectionState, FeedId, MarketType, Side } from './domain.js';

/** `gameKey`, e.g. "2026-10-25:PIT@NO" (kickoff date in US Eastern + away@home). */
export type GameKey = string;

export const cellKey = (game: GameKey, market: MarketType, side: Side): string => `${game}|${market}|${side}`;
export const quoteKey = (book: BookId, game: GameKey, market: MarketType, side: Side): string => `${book}|${game}|${market}|${side}`;

export interface WireBookMeta {
  id: BookId;
  name: string; // "DraftKings"
  short: string; // "DK"
  color: string; // CSS color for the book badge
  /** Jurisdiction whose lines are shown, e.g. "NJ" (reviewers outside it see different lines). */
  region?: string;
}

export interface WireFeedStatus {
  id: FeedId;
  state: ConnectionState;
  stale: boolean;
  detail: string | null;
  lastDataAt: number | null;
}

export interface WireBookStatus {
  book: BookId;
  /** Best state across this book's feeds. */
  state: ConnectionState;
  /** True only when every feed for this book is stale (after the grace period). */
  stale: boolean;
  detail: string | null;
  /** Newest proof of liveness across healthy feeds (frame, keepalive or successful poll). */
  lastDataAt: number | null;
  /** Last time a merged price, line or suspension for this book changed. */
  lastChangeAt: number | null;
  feeds: WireFeedStatus[];
}

export interface WireGame {
  key: GameKey;
  away: string; // team code, e.g. "PIT"
  home: string;
  awayName: string; // "Pittsburgh Steelers"
  homeName: string;
  start: string; // ISO-8601 UTC kickoff (earliest across books)
  live: boolean; // any book says in play
  books: BookId[]; // books currently listing the game
  /** Cross-book sanity check failed (likely a mapping error); excluded from Best Price. */
  suspect?: boolean;
}

export interface WirePrev {
  american: number;
  line: number | null;
  /** When the displayed value moved from `prev` to the current one (board clock). */
  at: number;
}

export interface WireQuote {
  book: BookId;
  game: GameKey;
  market: MarketType;
  side: Side;
  /** Spread for this side (-7.5), the total (51.5), or null for moneyline. */
  line: number | null;
  /** Always the book's actual displayed price. */
  american: number;
  suspended: boolean;
  live: boolean;
  /** Book's own change timestamp, when its feed exposes one (DK createdTime; FD PIR updatedAt, whole seconds). */
  bt: number | null;
  /** When the first copy of this value was received. */
  rx: number;
  /** Channel that delivered the first copy. */
  ch: Channel;
  /** Feed (box) that delivered the first copy. */
  feed: FeedId;
  /** Previous displayed price/line; set only when `american` or `line` changed. */
  prev?: WirePrev;
}

/**
 * Best Price rules (Decisions.txt D-21). `exact` = a direct price comparison on identical terms.
 *  R1 moneyline: higher payout                                                  exact
 *  R2 same line (spread/total): higher payout                                    exact
 *  R3 pregame spread, different lines, anchor available: highest est. return    est.
 *  R4 different lines, no model applies (totals, live spreads, no anchor):
 *     better line for the bettor first, then payout                             by line
 *  R5 equal displayed price on equal terms: tie, every book listed               exact
 */
export type BestRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export interface WireBestPick {
  game: GameKey;
  market: MarketType;
  side: Side;
  none?: false;
  /** Books offering the best (several on a tie). */
  books: BookId[];
  line: number | null;
  american: number;
  exact: boolean;
  rule: BestRule;
  reason: string;
  /** Why this cell changed: a real price move, or a book entering/leaving eligibility (no flash). */
  cause: 'price' | 'eligibility';
}

export interface WireBestNone {
  game: GameKey;
  market: MarketType;
  side: Side;
  none: true;
  cause: 'price' | 'eligibility';
}

export type WireBest = WireBestPick | WireBestNone;

export interface Snapshot {
  boot: string;
  seq: number;
  ts: number;
  books: WireBookMeta[];
  status: WireBookStatus[];
  games: WireGame[];
  quotes: WireQuote[];
  bests: WireBest[];
}

export interface Delta {
  seq: number;
  ts: number;
  games?: WireGame[];
  removedGames?: GameKey[];
  quotes?: WireQuote[];
  /** `quoteKey()` strings. */
  removedQuotes?: string[];
  bests?: WireBest[];
  status?: WireBookStatus[];
}

export interface Heartbeat {
  boot: string;
  seq: number;
  ts: number;
  status: WireBookStatus[];
}

export const sseId = (boot: string, seq: number): string => `${boot}.${seq}`;

export function parseSseId(id: string | null | undefined): { boot: string; seq: number } | null {
  if (!id) return null;
  const dot = id.lastIndexOf('.');
  if (dot <= 0) return null;
  const seq = Number(id.slice(dot + 1));
  return Number.isSafeInteger(seq) && seq >= 0 ? { boot: id.slice(0, dot), seq } : null;
}

/** `GET /api/time` */
export interface TimeResponse {
  now: number;
}

/** One browser-measured update, sent in batches to `POST /api/latency`. */
export interface LatencySample {
  book: BookId;
  phase: 'pre' | 'live';
  ch: Channel;
  feed: FeedId;
  /** Browser receive (on the server clock) minus the delta's `ts`. */
  serverToBrowser: number;
  /** Browser receive (on the server clock) minus `rx`. */
  rxToBrowser: number;
  /** Browser receive (on the server clock) minus `bt`, when the book stamped the change. */
  bookToBrowser: number | null;
  /** Receive to the next animation frame after the store applied the update. */
  paint: number;
}

/** Samples per beacon: the page keeps at most this many between sends, and the server reads no more. */
export const MAX_BEACON_SAMPLES = 300;

export interface LatencyReport {
  v: 1;
  /** Estimated server clock minus browser clock, and its error bound (half the best round trip). */
  offsetMs: number;
  offsetErrMs: number;
  samples: LatencySample[];
}
