import { lastDataAt, staleWord } from '../lib/bookStatus';
import { clock } from '../lib/clock';
import { formatAge } from '../lib/format';
import { useBooks, useBookStatus, useConnection, useEligibility, useNow } from '../lib/store';
import { WarningIcon } from './icons';

interface Notice {
  key: string;
  lead: string;
  age: number | null;
}

/**
 * Says plainly when what's on screen is old: a stale book ("FanDuel feed down — showing last known
 * prices from 2m ago"), or our own stream being down, in which case the whole board is stale.
 */
export function StaleBanner() {
  const elig = useEligibility();
  const conn = useConnection();
  const books = useBooks();
  const status = useBookStatus();
  const now = useNow();
  const notices: Notice[] = [];
  if (elig.disconnected) {
    notices.push({
      key: 'stream',
      lead: 'Reconnecting to the odds server',
      age: conn.lastFrameAt === null ? null : Math.max(0, now - conn.lastFrameAt),
    });
  } else {
    for (const b of books) {
      const s = status.get(b.id);
      if (s === undefined || !s.stale) continue;
      notices.push({ key: b.id, lead: `${b.name} feed ${staleWord(s)}`, age: clock.age(lastDataAt(s) ?? s.lastChangeAt, now) });
    }
  }
  if (notices.length === 0) return null;
  return (
    <div role="status" className="border-b border-amber-400/20 bg-amber-400/[0.06]" data-stale-banner>
      <div className="mx-auto flex max-w-5xl flex-col gap-1 px-4 py-2 sm:px-6">
        {notices.map((n) => (
          <p key={n.key} className="flex items-start gap-2 text-sm text-amber-100">
            <WarningIcon className="mt-0.5 size-4 shrink-0 text-amber-300" />
            <span>
              {n.lead} — showing last known prices
              {/* The age ticks every second; keep it out of the announcement. */}
              <span aria-live="off">{n.age === null ? '' : ` from ${formatAge(n.age)} ago`}</span>.
            </span>
          </p>
        ))}
      </div>
    </div>
  );
}
