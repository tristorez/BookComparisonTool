/**
 * The books this deployment knows about, one entry each. Adding a book: write its connector
 * (src/books/<book>.ts, a BookConnector subclass), add its id to BOOK_IDS (src/shared/domain.ts) and an
 * entry here, plus a settings section in config.ts if it has any; the type checker asks for whatever is
 * missing. Nothing else in the app names a book: config (BOOKS, FAKE_MODE_<short>,
 * STALE_AFTER_<short>_MS), the synthetic books, the board and best price, the stream, the feed link, the
 * UI (toggle, status chips, game page) and `npm run watch` all read this table.
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
  /**
   * Share of price changes our own polling sees before push (default 0: push only). FD's 1 s poll was
   * first on 151 of 337 live changes; the synthetic book (BOOKS=fake) splits its channels the same way.
   */
  pollShare?: number;
}

interface BookEntry extends BookSpec {
  /** The jurisdiction whose lines the connector reads, e.g. "nj". */
  jurisdiction(cfg: Config): string;
  /** This box's connector for the book, built from the book's settings section in `cfg`. */
  create(cfg: Config): BookConnector;
}

export const BOOKS: Record<BookId, BookEntry> = {
  draftkings: {
    id: 'draftkings',
    name: 'DraftKings',
    short: 'DK',
    color: '#53d337',
    staleAfterMs: 15_000,
    bookTimeResolutionMs: 0,
    jurisdiction: (cfg) => cfg.dk.state,
    create: (cfg) => new DraftKingsConnector(cfg.dk),
  },
  fanduel: {
    id: 'fanduel',
    name: 'FanDuel',
    short: 'FD',
    color: '#1493ff',
    staleAfterMs: 5_000,
    bookTimeResolutionMs: 1_000,
    pollShare: 0.45,
    jurisdiction: (cfg) => cfg.fd.region,
    create: (cfg) => new FanDuelConnector(cfg.fd),
  },
};

/** The jurisdiction whose lines a book's connector reads, shown under the board; none for synthetic books. */
export function regionOf(book: BookId, cfg: Config): string | undefined {
  return cfg.fake ? undefined : BOOKS[book].jurisdiction(cfg).toUpperCase();
}

/** This box's connector for `book`; under BOOKS=fake, a synthetic book shaped like it. */
export function createConnector(book: BookId, cfg: Config): BookConnector {
  if (cfg.fake) return new FakeConnector(BOOKS[book], { seed: cfg.fake.seed, ratePerSec: cfg.fake.ratePerSec, mode: cfg.fake.modes[book] });
  return BOOKS[book].create(cfg);
}
