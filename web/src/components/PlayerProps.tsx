import { useRef, useState } from 'react';
import type { BookId } from '@shared/domain';
import { PROP_GROUPS, PROP_SIDE_TERMS, PROP_SIDES, PROP_STATS, type PropGroup, type PropSide, type PropStat } from '@shared/props';
import type { PropsResponse, WireBookMeta, WireGame, WirePropOffer, WirePropRow, WirePropsBook } from '@shared/wire';
import { clock } from '../lib/clock';
import { possessive, type Ineligibility, type IneligibleTag } from '../lib/eligibility';
import { formatAge } from '../lib/format';
import { compareForBettor, type PricePoint } from '../lib/odds';
import { PROPS_REFRESH_MS, useNearScreen, usePlayerProps } from '../lib/props';
import { useBooks, useNow, type Move } from '../lib/store';
import { BookName } from './BookName';
import { BestStar, IneligibleQuote, NoPrice, Price, useFreshMove } from './PriceCell';
import { TabList } from './TabList';

const GROUP_LABEL: Record<PropGroup, string> = { passing: 'Passing', rushing: 'Rushing', receiving: 'Receiving', touchdowns: 'Touchdowns' };
const GROUP_TABS = PROP_GROUPS.map((g) => ({ id: g, label: GROUP_LABEL[g] }));
const SIDE_LABEL: Record<PropSide, string> = { over: 'Over', under: 'Under', yes: 'Price' };
const STATS = Object.keys(PROP_STATS) as PropStat[];
/**
 * A price flashes only against the same tab's previous read, at most this much older (two refreshes):
 * coming back to a tab or a game after a while repaints it without flashing what moved meanwhile.
 */
const MOVE_WINDOW_MS = 2 * PROPS_REFRESH_MS;

const moveKey = (row: WirePropRow, book: BookId, side: PropSide): string => `${row.stat}|${row.player}|${book}|${side}`;
/** A stat this page knows: a newer server's new stat is skipped, not a crash. */
const known = (row: WirePropRow): boolean => row.stat in PROP_STATS;

/**
 * The game's player props from every book, a tab per group. Each stat is a table laid out like the market
 * tables above it: per player, the sportsbooks down the left (from the registry, so another book is
 * another row and the table stays four columns wide on a phone), the sides as columns, and the better
 * price per side starred. How each book's read went is shown above. Read while on or near the screen.
 */
export function PlayerProps({ game }: { game: WireGame }) {
  const books = useBooks();
  const [group, setGroup] = useState<PropGroup>(PROP_GROUPS[0]);
  const section = useRef<HTMLElement>(null);
  const near = useNearScreen(section);
  const { data, error } = usePlayerProps(game.key, group, near);
  const moves = usePropMoves(data);
  const label = GROUP_LABEL[group].toLowerCase();
  return (
    <section ref={section} aria-labelledby="props-heading" className="mt-2 flex flex-col gap-3 border-t border-white/[0.08] pt-5" data-props>
      <div className="flex flex-col gap-2 px-1 sm:flex-row sm:items-center sm:justify-between">
        <h3 id="props-heading" className="text-xs font-semibold tracking-wide text-muted uppercase">
          Player props
        </h3>
        <TabList options={GROUP_TABS} value={group} onChange={setGroup} label="Player prop groups" idPrefix="props-tab" controls="props-panel" compact />
      </div>
      {data !== undefined && <BookReads books={books} data={data} />}
      <div role="tabpanel" id="props-panel" aria-labelledby={`props-tab-${group}`} aria-busy={data === undefined && error === null} className="flex flex-col gap-3">
        {error !== null && data !== undefined && (
          <p role="status" className="px-1 text-xs text-amber-200">
            Couldn&apos;t refresh ({error}); showing the last props read.
          </p>
        )}
        {data === undefined ? (
          <p className="rounded-lg border border-white/[0.08] bg-navy-900 px-4 py-8 text-center text-sm text-muted">
            {error === null ? `Loading ${label} props…` : `Couldn't load player props (${error}). Retrying every ${PROPS_REFRESH_MS / 1000} s.`}
          </p>
        ) : !data.rows.some(known) ? (
          <p className="rounded-lg border border-white/[0.08] bg-navy-900 px-4 py-8 text-center text-sm text-muted">
            {data.books.some((b) => b.state === 'ok') ? `No ${label} props listed for this game yet.` : `No sportsbook's ${label} props are available right now.`}
          </p>
        ) : (
          STATS.filter((s) => PROP_STATS[s].group === group).map((stat) => {
            const rows = data.rows.filter((r) => r.stat === stat);
            return rows.length > 0 && <StatTable key={stat} stat={stat} rows={rows} books={books} reads={data.books} game={game} moves={moves} />;
          })
        )}
      </div>
      <PropsLegend />
    </section>
  );
}

/** One line per book: how many props it listed and how old they are, or why there are none. */
function BookReads({ books, data }: { books: readonly WireBookMeta[]; data: PropsResponse }) {
  const now = useNow();
  return (
    <ul aria-label="Sportsbook props status" className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs" data-prop-books>
      {books.map((b) => {
        const read = data.books.find((x) => x.book === b.id);
        const count = data.rows.filter((r) => known(r) && r.offers[b.id] !== undefined).length;
        const { text, warn } = readText(read, count, now);
        return (
          <li key={b.id} data-prop-book={b.id} data-state={read?.state ?? 'loading'} className="inline-flex items-center gap-1.5">
            <BookName meta={b} compact />
            <span className={warn ? 'text-amber-200' : 'text-faint'}>{text}</span>
          </li>
        );
      })}
    </ul>
  );
}

function readText(read: WirePropsBook | undefined, count: number, now: number): { text: string; warn: boolean } {
  if (read === undefined) return { text: 'loading…', warn: false };
  const age = clock.age(read.fetchedAt, now);
  switch (read.state) {
    case 'unsupported':
      return { text: 'no props feed', warn: false };
    case 'down':
      return { text: 'feed down', warn: true };
    case 'unlisted':
      return { text: "doesn't list this game", warn: false };
    case 'error':
      return { text: age === null ? `unavailable (${read.detail})` : `refresh failed (${read.detail}) · props from ${formatAge(age)} ago`, warn: true };
    case 'ok':
      if (count === 0) return { text: 'none listed yet', warn: false };
      return { text: `${count} ${count === 1 ? 'prop' : 'props'} · updated ${age === null ? 'just now' : `${formatAge(age)} ago`}`, warn: false };
    default:
      // A state from a newer server than this page.
      return { text: 'unavailable', warn: true };
  }
}

/** Whether a book's props can be shown at all: read fine, or still showing its last good read while reads fail. */
const readable = (read: WirePropsBook | undefined): boolean => read?.state === 'ok' || (read?.state === 'error' && read.fetchedAt !== null);

interface StatTableProps {
  stat: PropStat;
  rows: readonly WirePropRow[];
  books: readonly WireBookMeta[];
  /** How each book's read went (`PropsResponse.books`). */
  reads: readonly WirePropsBook[];
  game: WireGame;
  moves: ReadonlyMap<string, Move>;
}

/** One stat: per player a group of rows, one per sportsbook; the sides (over and under, or the price) as columns. */
function StatTable({ stat, rows, books, reads, game, moves }: StatTableProps) {
  const headingId = `props-${stat}`;
  const { kind, label } = PROP_STATS[stat];
  const sides = PROP_SIDES[kind];
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-white/[0.08] bg-navy-900" data-stat={stat}>
      <h4 id={headingId} className="px-3 pt-3 text-[11px] font-semibold tracking-wide text-faint uppercase sm:px-4">
        {label}
      </h4>
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[32%] sm:w-[30%]" />
          <col className="w-[16%] sm:w-[22%]" />
          {sides.map((side) => (
            <col key={side} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="px-2 pt-2 pb-1.5 text-left align-bottom text-[11px] font-normal text-faint sm:px-4">
              Player
            </th>
            <th scope="col" className="px-1 pt-2 pb-1.5 text-left align-bottom text-[11px] font-normal text-faint">
              Sportsbook
            </th>
            {sides.map((side) => (
              <th key={side} scope="col" className="px-1 pt-2 pb-1.5 text-center align-bottom text-xs font-semibold text-muted">
                {SIDE_LABEL[side]}
              </th>
            ))}
          </tr>
        </thead>
        {/* One tbody per player: the player's cell spans its book rows, and the group is one unit for screen readers. */}
        {rows.map((row) => (
          <tbody key={row.player} data-player={row.player} className="border-t border-white/[0.06]">
            {books.map((b, i) => (
              <tr key={b.id} data-book={b.id}>
                {i === 0 && (
                  <th scope="rowgroup" rowSpan={books.length} className="px-2 py-1.5 text-left align-middle font-normal sm:px-4">
                    <PlayerName row={row} game={game} />
                  </th>
                )}
                <th scope="row" className="px-1 py-1.5 text-left align-middle font-normal">
                  <BookName meta={b} compact />
                </th>
                {sides.map((side) => (
                  <td key={side} data-side={side} className="px-1 py-1.5 text-center align-middle">
                    <OfferPrice row={row} meta={b} read={reads.find((r) => r.book === b.id)} side={side} move={moves.get(moveKey(row, b.id, side))} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </section>
  );
}

function PlayerName({ row, game }: { row: WirePropRow; game: WireGame }) {
  const team = row.team === 'away' ? game.away : row.team === 'home' ? game.home : null;
  return (
    <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
      {/* Wraps rather than truncates: the cell spans every book's row, so a phone has height to spare. */}
      <span className="text-sm leading-tight font-semibold break-words text-ink">{row.name}</span>{' '}
      {team !== null && <span className="text-xs text-muted">{team}</span>}
    </span>
  );
}

interface OfferPriceProps {
  row: WirePropRow;
  meta: WireBookMeta;
  read: WirePropsBook | undefined;
  side: PropSide;
  move: Move | undefined;
}

/** One book's price on one side of a player's prop, drawn like the board's book cells: flash, previous price, star, hatching. */
function OfferPrice({ row, meta, read, side, move }: OfferPriceProps) {
  const fresh = useFreshMove(move);
  const offer: WirePropOffer | undefined = row.offers[meta.id];
  const american = offer?.prices[side];
  if (offer === undefined || american === undefined) {
    const label = offer !== undefined ? `No ${SIDE_LABEL[side].toLowerCase()} price` : readable(read) ? 'Not offered' : 'Not available';
    return <NoPrice label={label} />;
  }
  const inel = offerIneligibility(meta.name, read, offer);
  const best = row.best[side];
  const { market, side: marketSide } = PROP_SIDE_TERMS[side];
  const price = <Price market={market} side={marketSide} line={offer.line} american={american} move={fresh} dim={inel !== null} />;
  return (
    <span className="inline-flex items-center gap-0.5">
      {inel !== null ? (
        <IneligibleQuote inel={inel} align="end">
          {price}
        </IneligibleQuote>
      ) : (
        price
      )}
      {inel === null && best?.books.includes(meta.id) === true && <BestStar byLine={!best.exact} />}
    </span>
  );
}

/** Why an offer isn't compared for the best price, as the board words it: the book's reads are failing, or it suspended the prop. */
function offerIneligibility(bookName: string, read: WirePropsBook | undefined, offer: WirePropOffer): Ineligibility | null {
  const tags: IneligibleTag[] = [];
  const reasons: string[] = [];
  if (read?.state === 'error') {
    tags.push('stale');
    reasons.push(`${possessive(bookName)} props couldn't be refreshed (${read.detail ?? 'read failed'})`);
  }
  if (offer.suspended) {
    tags.push('suspended');
    reasons.push(`${bookName} has suspended betting on this prop`);
  }
  return tags.length === 0 ? null : { tags, reasons };
}

/**
 * Prices that changed between two consecutive reads of a tab, as the board's moves (flash, previous
 * price): green when the change favors the bettor, by `compareForBettor` in the prop side's market terms.
 * A tab's first read moves nothing, nor does a read more than MOVE_WINDOW_MS after the one it would be
 * compared with; an offer that drops out forgets its history; and cells mounted after a move don't flash
 * it (`useFreshMove`).
 */
function usePropMoves(data: PropsResponse | undefined): ReadonlyMap<string, Move> {
  const memory = useRef({ data: undefined as PropsResponse | undefined, seen: new Map<string, PricePoint & { ts: number }>(), moves: new Map<string, Move>(), n: 0 });
  const m = memory.current;
  // Idempotent per response (guarded by identity), so a second render of the same data changes nothing.
  if (data !== undefined && data !== m.data) {
    m.data = data;
    const present = new Set<string>();
    for (const row of data.rows) {
      if (!known(row)) continue;
      for (const [book, offer] of Object.entries(row.offers) as [BookId, WirePropOffer][]) {
        for (const side of PROP_SIDES[PROP_STATS[row.stat].kind]) {
          const american = offer.prices[side];
          if (american === undefined) continue;
          const key = moveKey(row, book, side);
          present.add(key);
          const prev = m.seen.get(key);
          m.seen.set(key, { line: offer.line, american, ts: data.ts });
          if (prev === undefined || data.ts - prev.ts > MOVE_WINDOW_MS) continue;
          const terms = PROP_SIDE_TERMS[side];
          const c = compareForBettor(terms.market, terms.side, prev, { line: offer.line, american });
          if (c !== 0) m.moves.set(key, { n: ++m.n, dir: c > 0 ? 'up' : 'down', prevLine: prev.line, prevAmerican: prev.american, at: Date.now() });
        }
      }
    }
    // This tab's offers that dropped out: a later return starts afresh instead of flashing an old move.
    for (const key of [...m.seen.keys()]) {
      const stat = key.slice(0, key.indexOf('|')) as PropStat;
      if (!present.has(key) && PROP_STATS[stat]?.group === data.group) {
        m.seen.delete(key);
        m.moves.delete(key);
      }
    }
  }
  return m.moves;
}

function PropsLegend() {
  return (
    <ul className="flex flex-col gap-1 px-1 text-xs leading-relaxed text-faint" data-props-legend>
      <li>
        <span className="text-accent">★</span> The better price where two or more books offer that side. When their lines differ, the better line
        wins (lower for the over, higher for the under), then the price.
      </li>
      <li>
        Read from each book while this section is on screen, every {PROPS_REFRESH_MS / 1000} s. Hatched prices are suspended, or a book&apos;s last
        props while its reads fail, and are never starred; — means no price from that book (it doesn&apos;t offer it, or it couldn&apos;t be read).
      </li>
    </ul>
  );
}
