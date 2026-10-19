import { memo } from 'react';
import type { MarketType } from '@shared/domain';
import type { WireGame } from '@shared/wire';
import { formatKickoff, nickname } from '../lib/format';
import { MARKETS, MARKET_SIDES } from '../lib/shared';
import type { View } from '../lib/view';
import { PriceCell } from './PriceCell';
import { Tip } from './Tip';

const MARKET_LABEL: Record<MarketType, string> = { spread: 'Spread', total: 'Total', moneyline: 'Moneyline' };
const ROWS = [0, 1] as const; // away/over on top, home/under below

/** One game: kickoff (or LIVE), away above home, Spread | Total | Moneyline. */
export const GameRow = memo(function GameRow({ game, view }: { game: WireGame; view: View }) {
  const suspect = game.suspect === true;
  return (
    <article aria-label={`${game.awayName} at ${game.homeName}`} className="rounded-xl bg-navy-900 ring-1 ring-white/[0.06]" data-game={game.key}>
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

function TeamName({ code, name }: { code: string; name: string }) {
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

function LiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-rose-300 uppercase ring-1 ring-rose-400/30">
      <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-rose-400" />
      Live
    </span>
  );
}

function SuspectBadge() {
  return (
    <Tip
      align="start"
      tip="The books disagree sharply on this game, which usually means a mapping error. Its prices are shown but not used for Best Price."
    >
      <span className="rounded-sm bg-amber-300/10 px-1 text-[10px] leading-4 font-medium text-amber-200 ring-1 ring-amber-300/25">check</span>
    </Tip>
  );
}
