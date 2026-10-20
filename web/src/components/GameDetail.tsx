import { useEffect } from 'react';
import type { BookId, MarketType, Side } from '@shared/domain';
import type { GameKey, WireBookMeta, WireGame } from '@shared/wire';
import { formatEtDateLabel, formatKickoff, MINUS, nickname } from '../lib/format';
import { marketHold } from '../lib/odds';
import { MARKETS, MARKET_SIDES } from '../lib/shared';
import { isPick, useBooks, useCell, useGame, useLoaded, useQuote } from '../lib/store';
import { gameHref, isPlainClick } from '../lib/view';
import { LiveBadge, MARKET_LABEL, SuspectBadge } from './GameRow';
import { ChevronLeftIcon } from './icons';
import { METHOD_TIPS, methodLabel, PriceCell } from './PriceCell';
import { Tip, type TipAlign } from './Tip';

const HOLD_TIP =
  "The book's margin on this market: the implied probabilities of its two prices add up to 100% plus the hold. Lower is better for bettors.";

const BADGE = 'rounded-sm border border-white/15 px-1 text-[10px] leading-4 font-medium text-muted';

/**
 * One game with every book compared: a table per market with a row per sportsbook (from the server's
 * registry, so another book is another row), the best price starred, a Best row naming the book, and
 * each book's hold.
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
        <p aria-busy={!loaded} className="rounded-lg border border-white/[0.08] bg-navy-900 px-4 py-12 text-center text-sm text-muted">
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
      className="inline-flex items-center gap-1 self-start rounded-md py-0.5 pr-1.5 text-sm text-muted hover:text-ink focus-ring"
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
      <h2 className="text-lg leading-snug font-semibold text-ink sm:text-xl">
        {game.awayName} <span className="font-normal text-faint">at</span> {game.homeName}
      </h2>
      <p className="text-xs text-faint">
        {books.length} {books.length === 1 ? 'sportsbook' : 'sportsbooks'} compared · prices update live
      </p>
    </header>
  );
}

/**
 * One market: a row per sportsbook down the left, so the list grows downward as books are added; the
 * market's two sides as columns; each book's hold; and a Best row naming the book.
 */
function MarketTable({ game, market, books }: { game: WireGame; market: MarketType; books: readonly WireBookMeta[] }) {
  const headingId = `market-${market}`;
  const suspect = game.suspect === true;
  const sides = MARKET_SIDES[market];
  // The right-hand column's tooltips open leftwards so they stay on a phone's screen.
  const align = (side: Side): TipAlign => (side === sides[0] ? 'center' : 'end');
  return (
    <section aria-labelledby={headingId} className="rounded-lg border border-white/[0.08] bg-navy-900" data-market={market}>
      <h3 id={headingId} className="px-3 pt-3 text-[11px] font-semibold tracking-wide text-faint uppercase sm:px-4">
        {MARKET_LABEL[market]}
      </h3>
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[31%] sm:w-[28%]" />
          <col />
          <col />
          <col className="w-[15%] sm:w-[12%]" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="px-2 pt-2 pb-1.5 text-left align-bottom text-[11px] font-normal text-faint sm:px-4">
              Sportsbook
            </th>
            {sides.map((side) => (
              <th key={side} scope="col" className="px-1 pt-2 pb-1.5 text-center align-bottom font-normal">
                <SideHeading game={game} market={market} side={side} />
              </th>
            ))}
            <th scope="col" className="px-1 pt-2 pb-1.5 text-center align-bottom text-[11px] font-normal text-faint">
              <Tip align="end" tip={HOLD_TIP}>
                <span className="underline decoration-dotted underline-offset-2">Hold</span>
              </Tip>
            </th>
          </tr>
        </thead>
        <tbody>
          {books.map((b) => (
            <tr key={b.id} data-book={b.id} className="border-t border-white/[0.05]">
              <th scope="row" className="px-2 py-2.5 text-left align-middle font-normal sm:px-4">
                <BookName meta={b} />
              </th>
              {sides.map((side) => (
                <td key={side} data-side={side} className="px-1 py-2.5 align-middle">
                  <PriceCell game={game.key} market={market} side={side} view={b.id} gameLive={game.live} gameSuspect={suspect} align={align(side)} />
                </td>
              ))}
              <td className="px-1 py-2.5 text-center align-middle">
                <HoldCell book={b.id} game={game.key} market={market} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr data-best-row className="border-t border-white/[0.1]">
            <th scope="row" className="px-2 pt-2.5 pb-3 text-left align-middle text-xs font-semibold text-accent sm:px-4">
              Best
            </th>
            {sides.map((side) => (
              <td key={side} data-side={side} className="px-1 pt-2.5 pb-3 align-middle">
                <PriceCell game={game.key} market={market} side={side} view="best" compare gameLive={game.live} gameSuspect={suspect} align={align(side)} />
              </td>
            ))}
            <td />
          </tr>
        </tfoot>
      </table>
      <PickNotes game={game} market={market} />
    </section>
  );
}

function BookName({ meta }: { meta: WireBookMeta }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
      <span title={meta.name} className="truncate text-sm font-semibold text-ink">
        {meta.name}
      </span>
    </span>
  );
}

function SideHeading({ game, market, side }: { game: WireGame; market: MarketType; side: Side }) {
  if (market === 'total') return <span className="text-xs font-semibold text-muted">{side === 'over' ? 'Over' : 'Under'}</span>;
  const [code, name] = side === 'away' ? [game.away, game.awayName] : [game.home, game.homeName];
  return (
    <span className="flex min-w-0 flex-col items-center leading-tight">
      <span className="text-sm font-semibold text-ink">{code}</span>{' '}
      <span className="max-w-full truncate text-[11px] text-muted">{nickname(name)}</span>
    </span>
  );
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
        <span className="text-accent">★</span> The best price for that side across the books; the Best row names the book.
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
