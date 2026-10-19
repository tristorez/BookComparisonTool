import { useConnection } from '../lib/store';

const LABEL = { open: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…' } as const;

/** Our own link to the board's stream (the book chips cover the sportsbooks). */
export function ConnectionIndicator() {
  const { state } = useConnection();
  const dot =
    state === 'open' ? 'bg-accent ring-4 ring-accent/20' : state === 'connecting' ? 'animate-pulse bg-slate-400' : 'animate-pulse bg-amber-400';
  const text = state === 'open' ? 'text-ink' : state === 'connecting' ? 'text-muted' : 'text-amber-200';
  return (
    <span
      role="status"
      data-connection={state}
      className="inline-flex shrink-0 items-center gap-2 rounded-full bg-navy-800 px-2.5 py-1 text-xs font-medium ring-1 ring-white/[0.06]"
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${dot}`} />
      <span className={text}>{LABEL[state]}</span>
    </span>
  );
}
