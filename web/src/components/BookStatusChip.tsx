import type { WireBookMeta, WireBookStatus } from '@shared/wire';
import { bookLevel, feedCountText, feedHealthy, lastDataAt, type BookLevel } from '../lib/bookStatus';
import { clock } from '../lib/clock';
import { formatAge } from '../lib/format';
import { useBookStatus, useEligibility, useNow } from '../lib/store';
import { Tip, type TipAlign } from './Tip';

const DOT: Record<BookLevel, string> = {
  live: 'bg-accent',
  degraded: 'bg-yellow-300',
  stale: 'bg-amber-400',
  down: 'bg-rose-500',
  connecting: 'bg-slate-400',
};

const LEVEL_TEXT: Record<BookLevel, string> = {
  live: 'text-accent',
  degraded: 'text-yellow-200',
  stale: 'text-amber-200',
  down: 'text-rose-300',
  connecting: 'text-muted',
};

/** Book health at a glance: state, last move (or how long it has been silent), and its feeds. */
export function BookStatusChip({ meta, align = 'start' }: { meta: WireBookMeta; align?: TipAlign }) {
  const status = useBookStatus().get(meta.id);
  const { disconnected } = useEligibility();
  const now = useNow();
  const level = bookLevel(status, disconnected);
  const silent = level === 'stale' || level === 'down';
  const quietFor = clock.age(lastDataAt(status), now);
  const lastMove = clock.age(status?.lastChangeAt, now);
  const detail = silent
    ? quietFor === null
      ? 'no data'
      : `no data for ${formatAge(quietFor)}`
    : lastMove === null
      ? 'no moves yet'
      : `last move ${formatAge(lastMove)} ago`;
  const feeds = feedCountText(status);
  return (
    <Tip align={align} tip={<FeedDetail meta={meta} status={status} now={now} />}>
      <span
        data-book={meta.id}
        data-level={level}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-0.5 text-xs whitespace-nowrap"
      >
        <span aria-hidden="true" className={`size-2 rounded-full ${DOT[level]}`} />
        <span className="font-semibold text-ink">
          <span className="sm:hidden">{meta.short}</span>
          <span className="hidden sm:inline">{meta.name}</span>
        </span>
        <span className={`font-medium ${LEVEL_TEXT[level]}`}>{level}</span>
        <span className="text-faint">· {detail}</span>
        {feeds !== null && <span className="text-faint">· {feeds}</span>}
      </span>
    </Tip>
  );
}

function FeedDetail({ meta, status, now }: { meta: WireBookMeta; status: WireBookStatus | undefined; now: number }) {
  if (status === undefined) return <>Waiting for {meta.name} status…</>;
  return (
    <span className="flex flex-col gap-1">
      <span className="font-semibold">{meta.name} feeds</span>
      {status.feeds.map((f) => {
        const age = clock.age(f.lastDataAt, now);
        const seen = age === null ? 'no data yet' : feedHealthy(f) ? `data ${formatAge(age)} ago` : `no data for ${formatAge(age)}`;
        return (
          <span key={f.id} className="block" data-feed={f.id}>
            Feed {f.id}: {f.stale ? 'stale' : f.state} · {seen}
            {f.detail !== null && f.detail !== '' && <span className="text-muted"> — {f.detail}</span>}
          </span>
        );
      })}
      {status.detail !== null && status.detail !== '' && <span className="text-muted">{status.detail}</span>}
      <span className="text-muted">The board keeps the first copy of each change from any feed; a book goes stale only when every feed does.</span>
    </span>
  );
}
