import type { GameKey } from '@shared/wire';
import { useConnection, useGames, useLoaded } from '../lib/store';
import type { View } from '../lib/view';
import { GameRow } from './GameRow';

/** Live games first, then one section per kickoff date (US Eastern). Games without quotes are hidden. */
export function Board({ view, onOpenGame }: { view: View; onOpenGame?: (game: GameKey) => void }) {
  const groups = useGames();
  const loaded = useLoaded();
  const { state } = useConnection();
  return (
    <div id="board" role="tabpanel" aria-labelledby={`view-tab-${view}`} className="flex flex-col gap-6">
      {groups.length === 0 ? (
        <EmptyBoard loaded={loaded} reconnecting={state === 'reconnecting'} />
      ) : (
        groups.map((g) => (
          <section key={g.id} aria-labelledby={`group-${g.id}`} className="flex flex-col gap-2">
            <h2 id={`group-${g.id}`} className="flex items-center gap-2 px-1 text-xs font-semibold tracking-wider text-muted uppercase">
              {g.live && <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-rose-400" />}
              {g.label}
              <span className="font-normal tracking-normal text-faint normal-case">
                · {g.games.length} {g.games.length === 1 ? 'game' : 'games'}
              </span>
            </h2>
            {g.games.map((game) => (
              <GameRow key={game.key} game={game} view={view} onOpen={onOpenGame} />
            ))}
          </section>
        ))
      )}
    </div>
  );
}

function EmptyBoard({ loaded, reconnecting }: { loaded: boolean; reconnecting: boolean }) {
  if (loaded) {
    return (
      <p className="rounded-xl bg-navy-900 px-4 py-12 text-center text-sm text-muted ring-1 ring-white/[0.06]">
        No NFL games on the board right now. New games appear here as soon as the books list them.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <p className="px-1 text-sm text-muted">{reconnecting ? 'Reconnecting to the odds server…' : 'Connecting to live odds…'}</p>
      {[0, 1, 2].map((i) => (
        <div key={i} aria-hidden="true" className="h-[7.5rem] animate-pulse rounded-xl bg-navy-900 ring-1 ring-white/[0.06]" />
      ))}
    </div>
  );
}
