import { memo, type MouseEvent } from 'react';
import type { MarketType } from '@shared/domain';
import type { GameKey, WireGame } from '@shared/wire';
import { formatKickoff, nickname } from '../lib/format';
import { MARKETS, MARKET_SIDES } from '../lib/shared';
import { gameHref, isPlainClick, type View } from '../lib/view';
import { ChevronRightIcon } from './icons';
import { PriceCell } from './PriceCell';
import { Tip } from './Tip';

/** Column and section headings, shared with the game page. */
export const MARKET_LABEL: Record<MarketType, string> = { spread: 'Spread', total: 'Total', moneyline: 'Moneyline' };
const ROWS = [0, 1] as const; // away/over on top, home/under below

interface GameRowProps {
  game: WireGame;
  view: View;
  /** Opens the game's side-by-side comparison of every book. */
  onOpen?: (game: GameKey) => void;
}

/** One game: kickoff (or LIVE), away above home, Spread | Total | Moneyline. Clicking it compares the books. */
export const GameRow = memo(function GameRow({ game, view, onOpen }: GameRowProps) {
  const suspect = game.suspect === true;
  // The whole card opens the comparison; links and tooltip triggers inside it keep their own clicks,
  // and so does selecting text.
  const onCardClick = (e: MouseEvent<HTMLElement>): void => {
    if (onOpen === undefined || !isPlainClick(e)) return;
    if ((e.target as Element).closest('a, button, [tabindex]')) return;
    if (window.getSelection()?.isCollapsed === false) return;
    onOpen(game.key);
  };
  return (
    <article
      aria-label={`${game.awayName} at ${game.homeName}`}
      className={`rounded-xl bg-navy-900 ring-1 ring-white/[0.06] ${onOpen ? 'cursor-pointer transition-shadow hover:ring-white/[0.16]' : ''}`}
      data-game={game.key}
      onClick={onCardClick}
    >
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col className="w-[27%] sm:w-[32%]" />
          {MARKETS.map((m) => (
            <col key={m} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="px-2 pt-2.5 pb-1 text-left align-bottom font-normal sm:px-3">
              <span className="flex flex-wrap items-center gap-1.5">
                {game.live ? (
                  <LiveBadge />
                ) : (
                  <time dateTime={game.start} className="text-xs whitespace-nowrap text-muted">
                    {formatKickoff(game.start)}
                  </time>
                )}
                {suspect && <SuspectBadge />}
                {onOpen && <CompareLink game={game} onOpen={onOpen} />}
              </span>
            </th>
            {MARKETS.map((m) => (
              <th key={m} scope="col" className="px-0.5 pt-2.5 pb-1 text-center align-bottom text-[10px] font-semibold tracking-wider text-faint uppercase">
                {MARKET_LABEL[m]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row} className={row === 1 ? 'border-t border-white/[0.05]' : undefined}>
              <th scope="row" className="px-2 py-2 text-left align-middle font-normal sm:px-3">
                <TeamName code={row === 0 ? game.away : game.home} name={row === 0 ? game.awayName : game.homeName} />
              </th>
              {MARKETS.map((m) => (
                <td key={m} className="px-0.5 py-2 align-middle">
                  <PriceCell
                    game={game.key}
                    market={m}
                    side={MARKET_SIDES[m][row]}
                    view={view}
                    gameLive={game.live}
                    gameSuspect={suspect}
                    align={m === 'moneyline' ? 'end' : 'center'}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </article>
  );
});

/** A real link to the game page (so a new tab or a copied link works); a plain click opens it in place. */
function CompareLink({ game, onOpen }: { game: WireGame; onOpen: (game: GameKey) => void }) {
  return (
    <a
      href={gameHref(game.key)}
      onClick={(e) => {
        if (!isPlainClick(e)) return;
        e.preventDefault();
        onOpen(game.key);
      }}
      aria-label={`Compare every book: ${game.awayName} at ${game.homeName}`}
      data-compare
      className="inline-flex items-center gap-0.5 rounded-sm text-[11px] font-medium text-accent/90 outline-none hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/70"
    >
      <span className="hidden sm:inline">Compare</span>
      <ChevronRightIcon className="size-3.5" />
    </a>
  );
}

/** Team code plus its name: the nickname on phones, the full name from `sm` up. */
export function TeamName({ code, name }: { code: string; name: string }) {
  return (
    <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
      <span className="text-sm font-bold text-ink">{code}</span>
      <span className="truncate text-xs text-muted sm:text-sm">
        <span className="sm:hidden">{nickname(name)}</span>
        <span className="hidden sm:inline">{name}</span>
      </span>
    </span>
  );
}

/** Shown instead of the kickoff time while any book has the game in play. */
export function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-rose-300 uppercase ring-1 ring-rose-400/30">
      <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-rose-400" />
      Live
    </span>
  );
}

/** The board's cross-book sanity check failed for this game (`WireGame.suspect`). */
export function SuspectBadge() {
  return (
    <Tip
      align="start"
      tip="The books disagree sharply on this game, which usually means a mapping error. Its prices are shown but not used for Best Price."
    >
      <span className="rounded-sm bg-amber-300/10 px-1 text-[10px] leading-4 font-medium text-amber-200 ring-1 ring-amber-300/25">check</span>
    </Tip>
  );
}
