import { Fragment, memo, useRef, type ReactNode } from 'react';
import type { BookId, MarketType, Side } from '@shared/domain';
import type { GameKey, WireBestPick, WireBookMeta } from '@shared/wire';
import { ELIGIBLE, ineligibility, ineligibleTooltip, type Ineligibility } from '../lib/eligibility';
import { formatAmerican, formatLine, formatPrice } from '../lib/format';
import { isPick, useBooks, useCell, useEligibility, useQuote, useWithin, type Move } from '../lib/store';
import type { View } from '../lib/view';
import { LockIcon } from './icons';
import { Tip, type TipAlign } from './Tip';

/** How long the previous price stays (struck through) beside a moved one. */
export const PREV_PRICE_MS = 5000;

export const METHOD_TIPS = {
  est: "Lines differ. Picked by estimated return per $1 using the books' no-vig consensus and NFL push rates.",
  byLine: 'Lines differ. Picked the better line for the bettor, then the better price; no value model applies.',
} as const;

export interface MethodLabel {
  text: 'est.' | 'by line';
  tip: string;
  reason: string;
}

/** How a non-exact pick was made: `est.` for R3 (value model), `by line` for R4 (no model applies). */
export function methodLabel(pick: WireBestPick): MethodLabel | null {
  if (pick.exact) return null;
  return pick.rule === 'R3'
    ? { text: 'est.', tip: METHOD_TIPS.est, reason: pick.reason }
    : { text: 'by line', tip: METHOD_TIPS.byLine, reason: pick.reason };
}

export interface PriceCellProps {
  game: GameKey;
  market: MarketType;
  side: Side;
  view: View;
  gameLive: boolean;
  gameSuspect: boolean;
  align?: TipAlign;
}

/**
 * One side of one market. Each view mounts its own cell (keyed by view), so switching views starts
 * from a clean flash baseline and never flashes.
 */
export const PriceCell = memo(function PriceCell(props: PriceCellProps) {
  return props.view === 'best' ? <BestCell key="best" {...props} /> : <BookCell key={props.view} {...props} book={props.view} />;
});

/**
 * The move, but only if it happened after this cell mounted. Mounting (first load, a snapshot, a view
 * switch, a game moving between groups) therefore never flashes or shows a previous price.
 */
function useFreshMove(move: Move | undefined): Move | undefined {
  const baseline = useRef(move?.n ?? 0);
  return move !== undefined && move.n > baseline.current ? move : undefined;
}

function bookName(books: readonly WireBookMeta[], id: BookId): string {
  return books.find((b) => b.id === id)?.name ?? id;
}

// ---- Best Price view -------------------------------------------------------------------------------

function BestCell({ game, market, side, gameLive, gameSuspect, align = 'center' }: PriceCellProps) {
  const { best, move } = useCell(game, market, side);
  const books = useBooks();
  const fresh = useFreshMove(move);
  const pick = isPick(best) ? best : undefined;
  const others = pick === undefined ? books : books.filter((b) => !pick.books.includes(b.id));
  return (
    <div className="flex flex-col items-center gap-0.5 text-center" data-cell="best">
      {pick !== undefined ? (
        <BestPick pick={pick} move={fresh} books={books} game={game} market={market} side={side} gameLive={gameLive} gameSuspect={gameSuspect} align={align} />
      ) : (
        <span className="py-0.5 text-sm text-faint" data-none>
          <span aria-hidden="true">—</span>
          <span className="sr-only">No price</span>
        </span>
      )}
      {others.map((b) => (
        <OtherQuote key={b.id} meta={b} game={game} market={market} side={side} gameLive={gameLive} gameSuspect={gameSuspect} align={align} />
      ))}
    </div>
  );
}

interface BestPickProps {
  pick: WireBestPick;
  move: Move | undefined;
  books: readonly WireBookMeta[];
  game: GameKey;
  market: MarketType;
  side: Side;
  gameLive: boolean;
  gameSuspect: boolean;
  align: TipAlign;
}

function BestPick({ pick, move, books, game, market, side, gameLive, gameSuspect, align }: BestPickProps) {
  const elig = useEligibility();
  const first = pick.books[0];
  const { quote } = useQuote(first, game, market, side);
  // The server only picks eligible quotes; this catches what it can't know (our stream being down).
  const inel =
    first === undefined ? ELIGIBLE : ineligibility({ quote, book: first, bookName: bookName(books, first), gameLive, gameSuspect, elig });
  const ineligible = inel.tags.length > 0;
  const label = methodLabel(pick);
  const price = <Price market={market} side={side} line={pick.line} american={pick.american} move={move} dim={ineligible} />;
  return (
    <>
      {ineligible ? (
        <IneligibleQuote inel={inel} align={align}>
          {price}
        </IneligibleQuote>
      ) : (
        price
      )}
      <span data-books className="flex flex-wrap items-center justify-center gap-x-1.5 text-[11px] leading-4">
        <BookNames ids={pick.books} books={books} />
        {label !== null && <MethodBadge label={label} align={align} />}
      </span>
    </>
  );
}

function BookNames({ ids, books }: { ids: readonly BookId[]; books: readonly WireBookMeta[] }) {
  return (
    <span className="font-semibold tracking-wide text-muted" data-book-names>
      <span className="sr-only">Best at </span>
      {ids.map((id, i) => {
        const meta = books.find((b) => b.id === id);
        return (
          <Fragment key={id}>
            {i > 0 && ' · '}
            <span className="inline-flex items-center gap-1">
              <span aria-hidden="true" className="inline-block size-1.5 rounded-full" style={{ backgroundColor: meta?.color ?? 'currentColor' }} />
              <abbr title={meta?.name ?? id} className="no-underline">
                {meta?.short ?? id}
              </abbr>
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

function MethodBadge({ label, align }: { label: MethodLabel; align: TipAlign }) {
  return (
    <Tip
      align={align}
      tip={
        <>
          <span className="block">{label.tip}</span>
          {label.reason !== '' && <span className="mt-1 block text-muted">{label.reason}</span>}
        </>
      }
    >
      <span data-method={label.text} className="rounded-sm bg-sky-400/10 px-1 text-[10px] leading-4 font-medium text-sky-200 ring-1 ring-sky-300/25">
        {label.text}
      </span>
    </Tip>
  );
}

interface OtherQuoteProps {
  meta: WireBookMeta;
  game: GameKey;
  market: MarketType;
  side: Side;
  gameLive: boolean;
  gameSuspect: boolean;
  align: TipAlign;
}

/** Another book's price for the same side, muted, so the comparison is always on screen. */
function OtherQuote({ meta, game, market, side, gameLive, gameSuspect, align }: OtherQuoteProps) {
  const { quote } = useQuote(meta.id, game, market, side);
  const elig = useEligibility();
  if (quote === undefined) return null;
  const inel = ineligibility({ quote, book: meta.id, bookName: meta.name, gameLive, gameSuspect, elig });
  const p = formatPrice(market, side, quote.line, quote.american);
  const body = (
    <span data-other={meta.id} className="text-[11px] leading-4 text-faint tabular-nums">
      <abbr title={meta.name} className="font-semibold no-underline">
        {meta.short}
      </abbr>{' '}
      {p.line !== null && `${p.line} `}
      {p.odds}
    </span>
  );
  return inel.tags.length > 0 ? (
    <IneligibleQuote inel={inel} align={align} compact>
      {body}
    </IneligibleQuote>
  ) : (
    body
  );
}

// ---- Book views ----------------------------------------------------------------------------------

function BookCell({ book, game, market, side, gameLive, gameSuspect, align = 'center' }: PriceCellProps & { book: BookId }) {
  const { quote, move } = useQuote(book, game, market, side);
  const { best } = useCell(game, market, side);
  const books = useBooks();
  const elig = useEligibility();
  const fresh = useFreshMove(move);
  if (quote === undefined) {
    return (
      <div className="flex flex-col items-center text-center" data-cell={book}>
        <span className="py-0.5 text-sm text-faint" data-none>
          <span aria-hidden="true">—</span>
          <span className="sr-only">No price</span>
        </span>
      </div>
    );
  }
  const inel = ineligibility({ quote, book, bookName: bookName(books, book), gameLive, gameSuspect, elig });
  const ineligible = inel.tags.length > 0;
  const holdsBest = !ineligible && isPick(best) && best.books.includes(book);
  const price = <Price market={market} side={side} line={quote.line} american={quote.american} move={fresh} dim={ineligible} />;
  return (
    <div className="flex flex-col items-center text-center" data-cell={book}>
      <span className="inline-flex items-center gap-0.5">
        {ineligible ? (
          <IneligibleQuote inel={inel} align={align}>
            {price}
          </IneligibleQuote>
        ) : (
          price
        )}
        {holdsBest && (
          <span role="img" aria-label="Best price" title="Best price across books" className="text-xs leading-none text-accent">
            ★
          </span>
        )}
      </span>
    </div>
  );
}

// ---- shared pieces ---------------------------------------------------------------------------------

interface PriceProps {
  market: MarketType;
  side: Side;
  line: number | null;
  american: number;
  /** A move seen while this cell was on screen: flashes once and shows the previous price for 5 s. */
  move: Move | undefined;
  dim: boolean;
}

function Price({ market, side, line, american, move, dim }: PriceProps) {
  const showPrev = useWithin(move?.at, PREV_PRICE_MS);
  const p = formatPrice(market, side, line, american);
  const flash = move === undefined ? '' : move.dir === 'up' ? 'flash-up' : 'flash-down';
  const strong = dim ? 'font-medium text-muted' : 'font-semibold text-ink';
  return (
    <span className="inline-flex flex-wrap items-baseline justify-center gap-x-1">
      {/* Re-keyed by the move counter: each move remounts this span and restarts the CSS animation.
          Line over odds on phones (columns are ~80 px wide there), side by side from `sm` up. */}
      <span
        key={move?.n ?? 0}
        data-price
        data-flash={move?.dir}
        className={`inline-flex flex-col items-center rounded px-1 text-sm leading-5 whitespace-nowrap tabular-nums sm:flex-row sm:gap-1 ${flash}`}
      >
        {p.line !== null && <span className={strong}>{p.line}</span>}
        {p.line !== null && ' '}
        <span className={p.line === null ? strong : dim ? 'text-muted' : 'text-ink/90'}>{p.odds}</span>
      </span>
      {move !== undefined && showPrev && (
        <s data-prev className="text-[11px] whitespace-nowrap text-faint tabular-nums">
          <span className="sr-only">was </span>
          {prevText(market, side, line, move)}
        </s>
      )}
    </span>
  );
}

function prevText(market: MarketType, side: Side, line: number | null, move: Move): string {
  const odds = formatAmerican(move.prevAmerican);
  if (market === 'moneyline' || move.prevLine === line) return odds;
  const prevLine = formatLine(market, side, move.prevLine);
  return prevLine === null ? odds : `${prevLine} ${odds}`;
}

function IneligibleQuote({ inel, align, compact = false, children }: { inel: Ineligibility; align: TipAlign; compact?: boolean; children: ReactNode }) {
  return (
    <Tip align={align} tip={ineligibleTooltip(inel)}>
      <span
        data-ineligible={inel.tags.join(',')}
        className={`hatched inline-flex flex-wrap items-center justify-center gap-x-1 rounded px-1 ${compact ? '' : 'py-px'}`}
      >
        {inel.tags.includes('suspended') && <LockIcon className="size-3 shrink-0 text-muted" />}
        {children}
        <span data-tag className="rounded-sm bg-amber-300/10 px-1 text-[10px] leading-4 font-medium whitespace-nowrap text-amber-200 ring-1 ring-amber-300/25">
          {inel.tags[0]}
        </span>
      </span>
    </Tip>
  );
}
