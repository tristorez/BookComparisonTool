import type { WireBookStatus, WireFeedStatus } from '@shared/wire';

export type BookLevel = 'live' | 'degraded' | 'stale' | 'down' | 'connecting';

/** What a book's chip says. While our own stream is down nothing can be vouched for, so it reads stale. */
export function bookLevel(status: WireBookStatus | undefined, disconnected: boolean): BookLevel {
  if (status === undefined) return 'connecting';
  if (status.state === 'down' || status.state === 'stopped') return 'down';
  if (status.stale || disconnected) return 'stale';
  if (status.state === 'degraded') return 'degraded';
  if (status.state === 'connecting') return 'connecting';
  return 'live';
}

/** A feed that is delivering: not stale, and live or degraded (e.g. FanDuel push down, polling fine). */
export function feedHealthy(f: WireFeedStatus): boolean {
  return !f.stale && (f.state === 'live' || f.state === 'degraded');
}

/** "2 feeds" when all are healthy, "1/2 feeds" otherwise; null when the board reports no feeds. */
export function feedCountText(status: WireBookStatus | undefined): string | null {
  const feeds = status?.feeds ?? [];
  if (feeds.length === 0) return null;
  const healthy = feeds.filter(feedHealthy).length;
  const noun = feeds.length === 1 ? 'feed' : 'feeds';
  return healthy === feeds.length ? `${feeds.length} ${noun}` : `${healthy}/${feeds.length} ${noun}`;
}

/** Newest proof of liveness for a book: its own `lastDataAt`, else the newest of its feeds'. */
export function lastDataAt(status: WireBookStatus | undefined): number | null {
  if (status === undefined) return null;
  if (status.lastDataAt !== null) return status.lastDataAt;
  let newest: number | null = null;
  for (const f of status.feeds) if (f.lastDataAt !== null && (newest === null || f.lastDataAt > newest)) newest = f.lastDataAt;
  return newest;
}

/** "down", "degraded", "reconnecting" or "not updating", for "FanDuel feed down — …". */
export function staleWord(status: WireBookStatus): string {
  switch (status.state) {
    case 'down':
    case 'stopped':
      return 'down';
    case 'degraded':
      return 'degraded';
    case 'connecting':
      return 'reconnecting';
    case 'live':
      return 'not updating';
  }
}
