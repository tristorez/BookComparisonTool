import { useEffect } from 'react';
import type { BookId, MarketType, Side } from '@shared/domain';
import type { GameKey, WireBookMeta, WireGame } from '@shared/wire';
import { formatEtDateLabel, formatKickoff, MINUS } from '../lib/format';
import { marketHold } from '../lib/odds';
import { MARKETS, MARKET_SIDES } from '../lib/shared';
import { isPick, useBooks, useCell, useGame, useLoaded, useQuote } from '../lib/store';
import { gameHref, isPlainClick } from '../lib/view';
import { LiveBadge, MARKET_LABEL, SuspectBadge, TeamName } from './GameRow';
import { ChevronLeftIcon } from './icons';
import { METHOD_TIPS, methodLabel, PriceCell } from './PriceCell';
import { Tip } from './Tip';

const HOLD_TIP =
  "The book's margin on this market: the implied probabilities of its two prices add up to 100% plus the hold. Lower is better for bettors.";

const BADGE = 'rounded-sm bg-sky-400/10 px-1 text-[10px] leading-4 font-medium text-sky-200 ring-1 ring-sky-300/25';

/**
 * One game with every book side by side: a table per market with a column per book (from the server's
 * registry, so another book is another column), the best price starred, a Best column naming the book,
 * and each book's hold.
 */
export function GameDetail({ gameKey, onBack }: { gameKey: GameKey; onBack: () => void }) {
  const game = useGame(gameKey);
  const loaded = useLoaded();
  const books = useBooks();
  useDocumentTitle(game === undefined ? null : `${game.away} @ ${game.home} · NFL Odds Board`);
  return (
    <div className="flex flex-col gap-4" data-detail={gameKey}>
      <BackLink onBack={onBack} />
      {game === undefined ? (
        <p aria-busy={!loaded} className="rounded-xl bg-navy-900 px-4 py-12 text-center text-sm text-muted ring-1 ring-white/[0.06]">
          {loaded ? 'This game is no longer on the board.' : 'Connecting to live odds…'}
        </p>
      ) : (
        <>
          <GameHeading game={game} books={books} />
          {MARKETS.map((m) => (
            <MarketTable key={m} game={game} market={m} books={books} />
          ))}
          <Legend />
        </>
      )}
    </div>
  );
}

function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (title === null) return;
    const before = document.title;
    document.title = title;
    return () => {
      document.title = before;
    };
  }, [title]);
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <a
      href={gameHref(null)}
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        onBack();
      }}
      data-back
      className="inline-flex items-center gap-1 self-start rounded-md py-0.5 pr-1.5 text-sm text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      <ChevronLeftIcon className="size-4" />
      All games
    </a>
  );
}

function GameHeading({ game, books }: { game: WireGame; books: readonly WireBookMeta[] }) {
  return (
    <header className="flex flex-col gap-1.5 px-1">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        {game.live ? (
          <LiveBadge />
        ) : (
          <time dateTime={game.start}>
            {formatEtDateLabel(game.start)} · {formatKickoff(game.start)}
          </time>
        )}
        {game.suspect === true && <SuspectBadge />}
      </div>
      <h2 className="text-lg leading-snug font-bold tracking-tight text-ink sm:text-xl">
        {game.awayName} <span className="font-normal text-faint">at</span> {game.homeName}
      </h2>
      <p className="text-xs text-faint">
        {books.length} {books.length === 1 ? 'book' : 'books'} side by side · prices update live
      </p>
    </header>
  );
}

function MarketTable({ game, market, books }: { game: WireGame; market: MarketType; books: readonly WireBookMeta[] }) {
  const headingId = `market-${market}`;
  const suspect = game.suspect === true;
  // Up to three books fit a phone; beyond that the table scrolls sideways inside its card (which
  // would clip tooltips, so it only does so when it has to).
  const scroll = books.length > 3;
  const table = (
    <table className="w-full table-fixed border-collapse" style={scroll ? { minWidth: `${(books.length + 2) * 5.5}rem` } : undefined}>
      <colgroup>
        <col className="w-[24%] sm:w-[28%]" />
        {books.map((b) => (
          <col key={b.id} />
        ))}
        <col />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="px-2 pt-2 pb-1.5 sm:px-4">
            <span className="sr-only">{market === 'total' ? 'Side' : 'Team'}</span>
          </th>
          {books.map((b) => (
            <th key={b.id} scope="col" className="px-1 pt-2 pb-1.5 text-center text-[11px] font-semibold text-muted">
              <BookHeading meta={b} />
            </th>
          ))}
          <th scope="col" className="px-1 pt-2 pb-1.5 text-center text-[11px] font-semibold text-accent">
            Best
          </th>
        </tr>
      </thead>
      <tbody>
        {MARKET_SIDES[market].map((side) => (
          <tr key={side} className="border-t border-white/[0.05]">
            <th scope="row" className="px-2 py-2.5 text-left align-middle font-normal sm:px-4">
              <SideName game={game} market={market} side={side} />
            </th>
            {books.map((b, i) => (
              <td key={b.id} className="px-1 py-2.5 align-middle">
                {/* Tooltips in the right half open leftwards so they stay on a phone's screen. */}
                <PriceCell game={game.key} market={market} side={side} view={b.id} gameLive={game.live} gameSuspect={suspect} align={i < books.length / 2 ? 'center' : 'end'} />
              </td>
            ))}
            <td className="px-1 py-2.5 align-middle">
              <PriceCell game={game.key} market={market} side={side} view="best" compare gameLive={game.live} gameSuspect={suspect} align="end" />
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-white/[0.05]">
          <th scope="row" className="px-2 pt-2 pb-3 text-left align-middle text-[11px] font-normal text-faint sm:px-4">
            <Tip align="start" tip={HOLD_TIP}>
              <span className="underline decoration-dotted underline-offset-2">Hold</span>
            </Tip>
          </th>
          {books.map((b) => (
            <td key={b.id} className="px-1 pt-2 pb-3 text-center align-middle">
              <HoldCell book={b.id} game={game.key} market={market} />
            </td>
          ))}
          <td />
        </tr>
      </tfoot>
    </table>
  );
  return (
    <section aria-labelledby={headingId} className="rounded-xl bg-navy-900 ring-1 ring-white/[0.06]" data-market={market}>
      <h3 id={headingId} className="px-3 pt-3 text-[11px] font-semibold tracking-wider text-faint uppercase sm:px-4">
        {MARKET_LABEL[market]}
      </h3>
      {scroll ? <div className="overflow-x-auto">{table}</div> : table}
      <PickNotes game={game} market={market} />
    </section>
  );
}

function BookHeading({ meta }: { meta: WireBookMeta }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
      <abbr title={meta.name} className="no-underline sm:hidden">
        {meta.short}
      </abbr>
      <span className="hidden sm:inline">{meta.name}</span>
    </span>
  );
}

function SideName({ game, market, side }: { game: WireGame; market: MarketType; side: Side }) {
  if (market === 'total') return <span className="text-sm font-bold text-ink">{side === 'over' ? 'Over' : 'Under'}</span>;
  return side === 'away' ? <TeamName code={game.away} name={game.awayName} /> : <TeamName code={game.home} name={game.homeName} />;
}

function sideLabel(game: WireGame, market: MarketType, side: Side): string {
  if (market === 'total') return side === 'over' ? 'Over' : 'Under';
  return side === 'away' ? game.away : game.home;
}

/** A book's hold on this market, from its own two prices. */
function HoldCell({ book, game, market }: { book: BookId; game: GameKey; market: MarketType }) {
  const [first, second] = MARKET_SIDES[market];
  const a = useQuote(book, game, market, first).quote;
  const b = useQuote(book, game, market, second).quote;
  const h = a !== undefined && b !== undefined ? marketHold(market, a, b) : null;
  return (
    <span data-hold={book} className="text-[11px] text-faint tabular-nums">
      {h === null ? (
        <>
          <span aria-hidden="true">—</span>
          <span className="sr-only">Not available</span>
        </>
      ) : (
        `${h < 0 ? MINUS : ''}${Math.abs(h * 100).toFixed(1)}%`
      )}
    </span>
  );
}

/** How a pick across different lines was made, written out (the badge's tooltip, shown inline here). */
function PickNotes({ game, market }: { game: WireGame; market: MarketType }) {
  return (
    <div className="flex flex-col gap-1 px-3 pb-3 empty:hidden sm:px-4" data-notes>
      {MARKET_SIDES[market].map((side) => (
        <PickNote key={side} game={game} market={market} side={side} />
      ))}
    </div>
  );
}

function PickNote({ game, market, side }: { game: WireGame; market: MarketType; side: Side }) {
  const { best } = useCell(game.key, market, side);
  const label = isPick(best) ? methodLabel(best) : null;
  if (label === null || label.reason === '') return null;
  return (
    <p className="text-[11px] leading-4 text-faint" data-note={side}>
      <span className={BADGE}>{label.text}</span> <span className="font-semibold text-muted">{sideLabel(game, market, side)}:</span> {label.reason}
    </p>
  );
}

function Legend() {
  return (
    <ul className="flex flex-col gap-1 px-1 text-xs leading-relaxed text-faint" data-legend>
      <li>
        <span className="text-accent">★</span> The best price for that side across the books; the Best column names the book.
      </li>
      <li>
        <span className={BADGE}>est.</span> {METHOD_TIPS.est}
      </li>
      <li>
        <span className={BADGE}>by line</span> {METHOD_TIPS.byLine}
      </li>
      <li>Hold is each book&apos;s margin on the market; lower is better for bettors. Hatched prices are not used for Best Price.</li>
    </ul>
  );
}
