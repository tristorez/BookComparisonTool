import { useConnection } from '../lib/store';

const LABEL = { open: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…' } as const;

/** Our own link to the board's stream (the book chips cover the sportsbooks). */
export function ConnectionIndicator() {
  const { state } = useConnection();
  const dot =
    state === 'open' ? 'bg-accent' : state === 'connecting' ? 'animate-pulse bg-slate-400' : 'animate-pulse bg-amber-400';
  const text = state === 'open' ? 'text-ink' : state === 'connecting' ? 'text-muted' : 'text-amber-200';
  return (
    <span
      role="status"
      data-connection={state}
      className="inline-flex shrink-0 items-center gap-2 text-xs font-medium"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
      <span className={text}>{LABEL[state]}</span>
    </span>
  );
}
