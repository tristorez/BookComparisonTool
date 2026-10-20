/**
 * Primitive types shared by the connectors, the server and the browser. Browser-safe: no Node imports.
 * `src/books/types.ts` describes the same unions for the connectors; they are structurally identical.
 */

/** Every book the app can run. Adding one: its id here, its connector in src/books/, its entry in src/server/registry.ts. */
export const BOOK_IDS = ['draftkings', 'fanduel'] as const;
export type BookId = (typeof BOOK_IDS)[number];
export type MarketType = 'moneyline' | 'spread' | 'total';
export type Side = 'home' | 'away' | 'over' | 'under';
/** How a value reached us: REST snapshot, server push, or our own polling. */
export type Channel = 'snapshot' | 'push' | 'poll';
export type ConnectionState = 'connecting' | 'live' | 'degraded' | 'down' | 'stopped';
/** One ingestion box ("A", "B"). Each feed runs every book's connector. */
export type FeedId = string;

export const MARKETS: readonly MarketType[] = ['spread', 'total', 'moneyline'];

/** The two sides of each market, in display order (away/over on top). */
export const MARKET_SIDES: Readonly<Record<MarketType, readonly [Side, Side]>> = {
  moneyline: ['away', 'home'],
  spread: ['away', 'home'],
  total: ['over', 'under'],
};
