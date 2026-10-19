/**
 * Primitive types shared by the connectors, the server and the browser. Browser-safe: no Node imports.
 * `src/books/types.ts` describes the same unions for the connectors; they are structurally identical.
 */

export type BookId = 'draftkings' | 'fanduel';
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

export function oppositeSide(side: Side): Side {
  switch (side) {
    case 'home':
      return 'away';
    case 'away':
      return 'home';
    case 'over':
      return 'under';
    case 'under':
      return 'over';
  }
}
