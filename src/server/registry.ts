/**
 * The books this deployment knows about. Adding a book: write its connector, add an entry here and to
 * `createConnector`; the board, the stream and the UI (toggle, badges) pick it up from this list.
 */
import { DraftKingsConnector } from '../books/draftkings.js';
import { FanDuelConnector } from '../books/fanduel.js';
import type { BookConnector } from '../books/types.js';
import type { BookId } from '../shared/domain.js';
import type { WireBookMeta } from '../shared/wire.js';
import type { Config } from './config.js';
import { FakeConnector } from './fake.js';

export interface BookSpec extends WireBookMeta {
  /**
   * No proof of life for this long → stale (before the grace period). DK pings every 5 s and declares
   * the socket dead after 12 s; FD polls every second.
   */
  staleAfterMs: number;
  /** Resolution of the book's own timestamps: DK createdTime is ms (0), FD updatedAt whole seconds. */
  bookTimeResolutionMs: number;
}

export const BOOKS: Record<BookId, BookSpec> = {
  draftkings: { id: 'draftkings', name: 'DraftKings', short: 'DK', color: '#53d337', staleAfterMs: 15_000, bookTimeResolutionMs: 0 },
  fanduel: { id: 'fanduel', name: 'FanDuel', short: 'FD', color: '#1493ff', staleAfterMs: 5_000, bookTimeResolutionMs: 1_000 },
};

export const BOOK_IDS = Object.keys(BOOKS) as BookId[];

/** The jurisdiction whose lines a book's connector reads, shown under the board; none for synthetic books. */
export function regionOf(book: BookId, cfg: Config): string | undefined {
  if (cfg.fake) return undefined;
  switch (book) {
    case 'draftkings':
      return cfg.dk.state.toUpperCase();
    case 'fanduel':
      return cfg.fd.region.toUpperCase();
  }
}

export function createConnector(book: BookId, cfg: Config): BookConnector {
  if (cfg.fake) return new FakeConnector(book, { seed: cfg.fake.seed, ratePerSec: cfg.fake.ratePerSec, mode: cfg.fake.modes[book] });
  switch (book) {
    case 'draftkings':
      return new DraftKingsConnector({ state: cfg.dk.state, proxyUrl: cfg.dk.proxyUrl, restProxyUrl: cfg.dk.restProxyUrl, wsProxyUrl: cfg.dk.wsProxyUrl });
    case 'fanduel':
      return new FanDuelConnector({
        region: cfg.fd.region,
        push: cfg.fd.push,
        pollIntervalMs: cfg.fd.pollIntervalMs,
        pollPhaseMs: cfg.fd.pollPhaseMs,
        proxyUrl: cfg.fd.proxyUrl,
      });
  }
}
