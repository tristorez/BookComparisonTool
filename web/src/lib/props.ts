import { createContext, useContext, useEffect, useState, type RefObject } from 'react';
import type { PropGroup } from '@shared/props';
import type { GameKey, PropsResponse } from '@shared/wire';

/** How often an open props tab re-reads while it is on screen. The server shares each read for 10 s. */
export const PROPS_REFRESH_MS = 15_000;
/** Responses kept for tabs opened again (a few games' worth); the oldest go first. */
const CACHE_SIZE = 16;

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * Reads `GET /api/games/:game/props` and keeps the latest answer per game and tab, so a tab opened again
 * shows its last props at once while they refresh. Tests pass their own `fetch` and a shorter refresh.
 */
export class PropsClient {
  readonly refreshMs: number;
  private readonly fetchFn: FetchLike;
  private readonly cache = new Map<string, { data: PropsResponse; at: number }>();

  constructor(opts: { fetch?: FetchLike; refreshMs?: number } = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.refreshMs = opts.refreshMs ?? PROPS_REFRESH_MS;
  }

  /** The last answer for a game's tab, and when it arrived (local time). */
  cached(game: GameKey, group: PropGroup): { data: PropsResponse; at: number } | undefined {
    return this.cache.get(`${game}|${group}`);
  }

  async read(game: GameKey, group: PropGroup, signal: AbortSignal): Promise<void> {
    const res = await this.fetchFn(`/api/games/${encodeURIComponent(game)}/props?group=${group}`, { signal, cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'this game is no longer on the board' : `HTTP ${res.status}`);
    const data = (await res.json()) as PropsResponse;
    const key = `${game}|${group}`;
    this.cache.delete(key); // re-inserted last: the cache drops its oldest entries
    this.cache.set(key, { data, at: Date.now() });
    if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
  }
}

/** The app's props client. Tests render with their own. */
export const PropsContext = createContext(new PropsClient());

/**
 * One group of a game's player props. While `active` (on or near the screen) and the page is visible it
 * reads at once if the last answer is due, then every `refreshMs`; a hidden page stops reading and catches
 * up when it is shown again. Props are not on the stream.
 */
export function usePlayerProps(game: GameKey, group: PropGroup, active: boolean): { data: PropsResponse | undefined; error: string | null } {
  const client = useContext(PropsContext);
  const key = `${game}|${group}`;
  // The answer lives in the client; this state holds the last error and re-renders when a read lands.
  const [state, setState] = useState<{ key: string; error: string | null }>({ key, error: null });

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: AbortController | undefined;
    // One timer at a time: every reschedule clears the last, so none outlives the effect.
    const later = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), ms);
    };
    const load = async (): Promise<void> => {
      if (stopped) return;
      clearTimeout(timer);
      current?.abort();
      const mine = new AbortController();
      current = mine;
      try {
        await client.read(game, group, mine.signal);
        if (!mine.signal.aborted) setState({ key, error: null });
      } catch (err) {
        if (!mine.signal.aborted) setState({ key, error: err instanceof Error ? err.message : String(err) });
      } finally {
        // An aborted read was superseded or stopped: whoever aborted it schedules what comes next.
        if (!mine.signal.aborted && !document.hidden) later(client.refreshMs);
      }
    };
    /** Read now if the last answer is due, else when it will be; a hidden page reads nothing. */
    const resume = (): void => {
      if (document.hidden) {
        clearTimeout(timer);
        return;
      }
      const age = Date.now() - (client.cached(game, group)?.at ?? Number.NEGATIVE_INFINITY);
      if (age >= client.refreshMs) void load();
      else later(client.refreshMs - age);
    };
    resume();
    document.addEventListener('visibilitychange', resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      current?.abort();
      document.removeEventListener('visibilitychange', resume);
    };
  }, [client, game, group, key, active]);

  return { data: client.cached(game, group)?.data, error: state.key === key ? state.error : null };
}

/**
 * True while the element is on screen or within a screen of it, so a section below the fold reads just
 * before it scrolls into view. Always true where IntersectionObserver is missing.
 */
export function useNearScreen(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return undefined;
    // One element is observed, so the last entry of a batch is its current state.
    const observer = new IntersectionObserver((entries) => setNear(entries.at(-1)?.isIntersecting ?? false), { rootMargin: '100% 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return near;
}
