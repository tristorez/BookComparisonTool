/**
 * Player props for the game page (`GET /api/games/:game/props?group=`; Decisions.txt D-42).
 *
 * Props are not streamed. One group of one game is read on demand through this box's own connectors (an
 * FD event-page tab plus one SMP price read, one DK category read), and each read is shared by every
 * viewer for `ttlMs`, longer while a game has no props posted yet. Load on the books therefore grows with
 * the games being viewed, not with viewers, and the main lines' stream, merge and latency path are
 * untouched. A book that refuses a read (401/403/429) is left alone for a cool-down, as the connectors back
 * off when they are blocked.
 */
import { HttpError, errMsg, isBlocked, sleep } from '../books/http.js';
import type { BookGame, BookProp } from '../books/types.js';
import { rankOffers, type Offer } from '../shared/bestPrice.js';
import type { BookId } from '../shared/domain.js';
import { americanToDecimal, isValidAmerican } from '../shared/odds.js';
import { PROP_SIDE_TERMS, PROP_SIDES, PROP_STATS, playerKey, type PropGroup, type PropSide, type PropStat } from '../shared/props.js';
import type { GameKey, PropsResponse, WirePropOffer, WirePropRow, WirePropsBook } from '../shared/wire.js';

export type PropsReader = (game: BookGame, group: PropGroup) => Promise<BookProp[]>;

export interface PropsOptions {
  /** Registry books, in display order. */
  books: readonly BookId[];
  /** Each book's view of a game; null when the game is not on the board (`Board.bookGames`). */
  games: (game: GameKey) => Partial<Record<BookId, BookGame>> | null;
  /** This box's props reader per book (its connector's `fetchProps`); a book without one shows as unsupported. */
  readers: Partial<Record<BookId, PropsReader>>;
  /** Whether a book's feed is stale: then a game it doesn't list reads as down, not as unlisted. */
  bookDown?: (book: BookId) => boolean;
  /** A read is shared for this long after it lands, and a failed read is not retried sooner. */
  ttlMs?: number;
  /** Once reads start failing, the last good props stay on screen (not starred) this long; at least 2 × ttlMs. */
  maxAgeMs?: number;
  /** How long a request waits for a refresh when it already has props to show; the refresh lands for the next one. */
  readWaitMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

/** One book's group of props for one game. */
interface Entry {
  /** The last good read: its props, and when it landed. */
  last: { props: BookProp[]; at: number } | null;
  /** Why the last read failed; cleared by the next good one. */
  error: string | null;
  /** No new read starts before this. */
  freshUntil: number;
  inflight: Promise<void> | null;
  usedAt: number;
}

type Read = Entry['last'];

/** A game with no props posted yet (common for next week's) is looked at again only this often. */
const EMPTY_TTL_MS = 60_000;
/**
 * A book that refuses reads (401/403/429) is left alone for this long, doubling with each refusal in a row
 * up to BLOCKED_MAX_MS (or longer if its Retry-After asks), as the connectors back off a refusing host.
 */
const BLOCKED_BASE_MS = 60_000;
const BLOCKED_MAX_MS = 600_000;
/** Entries nobody has asked for in this long are dropped. */
const IDLE_EVICT_MS = 10 * 60_000;
const STAT_ORDER = new Map((Object.keys(PROP_STATS) as PropStat[]).map((s, i) => [s, i]));

export class PropsService {
  /** By `<book>|<event id>|<group>`. */
  private readonly cache = new Map<string, Entry>();
  /** Merged rows by `<game>|<group>`, reused while every book shows the same read in the same state. */
  private readonly merged = new Map<string, { reads: readonly Read[]; stale: readonly boolean[]; rows: WirePropRow[]; usedAt: number }>();
  /** Per book: refusals in a row, and no reads before `until`. */
  private readonly blocked = new Map<BookId, { streak: number; until: number }>();
  private readonly ttlMs: number;
  private readonly maxAgeMs: number;
  private readonly readWaitMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  /** Served in /api/metrics: reads started, reads failed, and requests that joined a read already in flight. */
  readonly counters = { reads: 0, failures: 0, joined: 0 };

  constructor(private readonly opts: PropsOptions) {
    this.ttlMs = opts.ttlMs ?? 10_000;
    // Never shorter than two reads apart, or a book would blank between two good reads.
    this.maxAgeMs = Math.max(opts.maxAgeMs ?? 120_000, 2 * this.ttlMs);
    this.readWaitMs = opts.readWaitMs ?? 1_500;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** One group of a game's props from every book, or null when the game is not on the board. */
  async get(game: GameKey, group: PropGroup): Promise<PropsResponse | null> {
    const games = this.opts.games(game);
    if (games === null) return null;
    this.evict();
    const perBook = await Promise.all(this.opts.books.map((book) => this.bookRead(book, games[book], group)));
    return { game, group, ts: this.now(), books: perBook.map((b) => b.meta), rows: this.rows(game, group, perBook) };
  }

  /** One book's state for the response, and its last good read while it is recent enough to show. */
  private async bookRead(book: BookId, game: BookGame | undefined, group: PropGroup): Promise<{ meta: WirePropsBook; shown: Read }> {
    const reader = this.opts.readers[book];
    if (reader === undefined) return { meta: { book, state: 'unsupported', detail: null, fetchedAt: null }, shown: null };
    if (game === undefined) return { meta: { book, state: this.opts.bookDown?.(book) ? 'down' : 'unlisted', detail: null, fetchedAt: null }, shown: null };
    const e = await this.read(book, game, group, reader);
    const shown = e.last !== null && this.now() - e.last.at <= this.maxAgeMs ? e.last : null;
    return { meta: { book, state: e.error === null ? 'ok' : 'error', detail: e.error, fetchedAt: shown?.at ?? null }, shown };
  }

  /** The rows for one group of one game: merged again only when a book's shown read, or its state, changed. */
  private rows(game: GameKey, group: PropGroup, perBook: readonly { meta: WirePropsBook; shown: Read }[]): WirePropRow[] {
    const key = `${game}|${group}`;
    const reads = perBook.map((b) => b.shown);
    // A book whose reads are failing still shows its last good props, but they can't be best, as on the board.
    const stale = perBook.map((b) => b.meta.state === 'error');
    const hit = this.merged.get(key);
    if (hit !== undefined && hit.reads.every((r, i) => r === reads[i]) && hit.stale.every((s, i) => s === stale[i])) {
      hit.usedAt = this.now();
      return hit.rows;
    }
    const rows = mergeProps(
      perBook.map(({ meta, shown }, i) => ({
        book: meta.book,
        // A tab can list another group's stat (FD's receiving tab carries rush + receiving yards, a rushing stat).
        props: shown?.props.filter((p) => PROP_STATS[p.stat].group === group) ?? [],
        stale: stale[i],
      })),
    );
    this.merged.set(key, { reads, stale, rows, usedAt: this.now() });
    return rows;
  }

  /**
   * The entry for one book's group of one game, refreshed first when due; concurrent requests share one
   * read. With props already to show, a request waits for the refresh only `readWaitMs`, so one slow
   * book doesn't hold the whole response.
   */
  private async read(book: BookId, game: BookGame, group: PropGroup, reader: PropsReader): Promise<Entry> {
    const key = `${book}|${game.bookEventId}|${group}`;
    const now = this.now();
    let e = this.cache.get(key);
    if (e === undefined) this.cache.set(key, (e = { last: null, error: null, freshUntil: 0, inflight: null, usedAt: now }));
    e.usedAt = now;
    if (e.inflight !== null) {
      this.counters.joined++;
    } else if (now >= e.freshUntil) {
      const block = this.blocked.get(book);
      if (block !== undefined && now < block.until) e.error = `refused by the book; retrying in ${Math.ceil((block.until - now) / 1000)}s`;
      else this.start(book, game, group, reader, e);
    }
    const showable = e.last !== null && now - e.last.at <= this.maxAgeMs;
    if (e.inflight !== null) await (showable ? Promise.race([e.inflight, sleep(this.readWaitMs)]) : e.inflight);
    return e;
  }

  private start(book: BookId, game: BookGame, group: PropGroup, reader: PropsReader, e: Entry): void {
    this.counters.reads++;
    e.inflight = Promise.resolve()
      .then(() => reader(game, group))
      .then(
        (props) => {
          const at = this.now();
          const hadProps = (e.last?.props.length ?? 0) > 0;
          e.last = { props, at };
          e.error = null;
          this.blocked.delete(book);
          // Only a game that has never shown props waits a minute; an empty read after good ones may be a blip.
          e.freshUntil = at + (props.length === 0 && !hadProps ? EMPTY_TTL_MS : this.ttlMs);
        },
        (err: unknown) => {
          const at = this.now();
          this.counters.failures++;
          e.error = describe(err);
          e.freshUntil = at + this.ttlMs;
          this.log(`props: ${book} ${group} read for event ${game.bookEventId} failed: ${errMsg(err)}`);
          if (isBlocked(err)) {
            const streak = (this.blocked.get(book)?.streak ?? 0) + 1;
            const cooldown = Math.min(BLOCKED_MAX_MS, BLOCKED_BASE_MS * 2 ** (streak - 1));
            this.blocked.set(book, { streak, until: at + Math.max(err.retryAfterMs ?? 0, cooldown) });
          }
        },
      )
      .finally(() => {
        e.inflight = null;
      });
  }

  private evict(): void {
    const now = this.now();
    for (const [key, e] of this.cache) if (e.inflight === null && now - e.usedAt > IDLE_EVICT_MS) this.cache.delete(key);
    for (const [key, m] of this.merged) if (now - m.usedAt > IDLE_EVICT_MS) this.merged.delete(key);
  }
}

/** A failed read in words for the page: the status for HTTP errors (their bodies are HTML error pages), else the message. */
function describe(err: unknown): string {
  // A 2xx HttpError is a body that wasn't JSON (an interstitial or challenge page), not an HTTP failure.
  if (err instanceof HttpError) return err.status < 300 ? 'unreadable answer' : `HTTP ${err.status}${err.blocked ? ', refused by the book' : ''}`;
  if (err instanceof Error && err.name === 'TimeoutError') return 'timed out';
  return errMsg(err);
}

/**
 * Line the books up: one row per stat and player (`playerKey`, or the first book's name for a player the
 * books name differently: `nameAliases`), with each book's offer and the best price per side by the
 * board's own rules (src/shared/bestPrice.ts, in PROP_SIDE_TERMS' market terms): on the same line the
 * higher payout wins, on different lines the better line for the bettor (`by line`). Prices that aren't
 * usable American odds are dropped, as the board drops them.
 */
export function mergeProps(perBook: readonly { book: BookId; props: readonly BookProp[]; stale?: boolean }[]): WirePropRow[] {
  const rows = new Map<string, WirePropRow>();
  const stale = new Set(perBook.flatMap((b) => (b.stale ? [b.book] : [])));
  const aliases = nameAliases(perBook);
  for (const { book, props } of perBook) {
    for (const p of props) {
      const named = playerKey(p.player);
      const player = aliases.get(`${book}|${named}`) ?? named;
      const prices = Object.fromEntries(Object.entries(p.prices).filter(([, a]) => isValidAmerican(a))) as Partial<Record<PropSide, number>>;
      if (player === '' || Object.keys(prices).length === 0 || (PROP_STATS[p.stat].kind === 'ou' && (p.line === null || !Number.isFinite(p.line)))) continue;
      const key = `${p.stat}|${player}`;
      let row = rows.get(key);
      if (row === undefined) rows.set(key, (row = { stat: p.stat, player, name: p.player, team: p.team, offers: {}, best: {} }));
      row.team ??= p.team;
      // A book listing one player twice on a stat: the first listing stands.
      row.offers[book] ??= { line: p.line, prices, suspended: p.suspended };
    }
  }
  const out = [...rows.values()];
  for (const row of out) row.best = bestOf(row, stale);
  return out.sort(compareRows);
}

/**
 * Players the books name differently ("Cameron Ward" at DK is "Cam Ward" at FD, "Andrew Ogletree" is "Drew
 * Ogletree"), by `<book>|<playerKey>` to the first book's key. Within one tab of one game, two names are
 * one player when they play for the same team under the same surname, each book lists only one such
 * player, and one first name starts or ends the other. A pure nickname ("Bam" Knight is Zonovan) stays
 * two rows: a wrong join would compare two players' prices.
 */
function nameAliases(perBook: readonly { book: BookId; props: readonly BookProp[] }[]): Map<string, string> {
  // By `<team>|<surname>`: each book's names there, books in registry order.
  const places = new Map<string, Map<BookId, Set<string>>>();
  for (const { book, props } of perBook) {
    for (const p of props) {
      if (p.team === null) continue;
      const key = playerKey(p.player);
      const place = `${p.team}|${key.slice(key.lastIndexOf(' ') + 1)}`;
      const names = places.get(place) ?? new Map<BookId, Set<string>>();
      places.set(place, names);
      names.set(book, (names.get(book) ?? new Set<string>()).add(key));
    }
  }
  const aliases = new Map<string, string>();
  for (const names of places.values()) {
    // Two such players at one book: no telling which one another book's name is.
    if ([...names.values()].some((keys) => keys.size > 1)) continue;
    const only = [...names].map(([book, keys]) => ({ book, key: [...keys][0]! }));
    const first = only[0]!.key;
    for (const { book, key } of only) if (key !== first && sameFirstName(key, first)) aliases.set(`${book}|${key}`, first);
  }
  return aliases;
}

/** Two keys whose first names (all but the surname) are one a start or end of the other, at least two letters: "cam ward", "cameron ward". */
function sameFirstName(a: string, b: string): boolean {
  const first = (key: string) => key.slice(0, Math.max(0, key.lastIndexOf(' ')));
  const [short, long] = [first(a), first(b)].sort((x, y) => x.length - y.length) as [string, string];
  return short.length >= 2 && (long.startsWith(short) || long.endsWith(short));
}

/**
 * Best price per side, only where two or more books offer it unsuspended from a current read (`stale`
 * books' last good props are shown, not compared): a star means a comparison was made.
 */
function bestOf(row: WirePropRow, stale: ReadonlySet<BookId>): WirePropRow['best'] {
  const best: WirePropRow['best'] = {};
  for (const side of PROP_SIDES[PROP_STATS[row.stat].kind]) {
    const terms = PROP_SIDE_TERMS[side];
    const offers: Offer[] = [];
    for (const [book, o] of Object.entries(row.offers) as [BookId, WirePropOffer][]) {
      const american = o.prices[side];
      if (!o.suspended && !stale.has(book) && american !== undefined) offers.push({ book, side: terms.side, line: o.line, american });
    }
    if (offers.length < 2) continue;
    const r = rankOffers(offers, { market: terms.market, live: false, anchor: null });
    if (r !== null) best[side] = { books: r.books, exact: r.exact };
  }
  return best;
}

/** Stats in PROP_STATS order; within one, the biggest line first on over/unders (the starters), the favorite first on scorer markets. */
function compareRows(a: WirePropRow, b: WirePropRow): number {
  return STAT_ORDER.get(a.stat)! - STAT_ORDER.get(b.stat)! || weight(b) - weight(a) || a.name.localeCompare(b.name);
}

function weight(row: WirePropRow): number {
  let w = Number.NEGATIVE_INFINITY;
  for (const o of Object.values(row.offers)) {
    if (o === undefined) continue;
    const yes = o.prices.yes;
    w = Math.max(w, o.line ?? (yes === undefined ? Number.NEGATIVE_INFINITY : 1 / americanToDecimal(yes)));
  }
  return w;
}
