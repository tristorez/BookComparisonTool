import type { TimeResponse } from '@shared/wire';

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

export interface ClockOptions {
  url?: string;
  /** Round trips per sync; the one with the smallest RTT sets the offset. */
  samples?: number;
  refreshMs?: number;
  fetch?: FetchLike;
  wallNow?: () => number;
  perfNow?: () => number;
}

/**
 * Estimates the board's clock relative to this browser (Cristian's algorithm): of `samples` sequential
 * `GET /api/time` round trips, the fastest one wins, offset = server time − midpoint of that trip, and
 * the error bound is half its RTT. Every age shown on screen is corrected by the offset and clamped at 0,
 * so a browser clock that runs a few seconds fast or slow can't show "−3s ago" or hide a stale feed.
 */
export class ServerClock {
  private offsetMs = 0;
  private errMs = Number.POSITIVE_INFINITY;
  private isSynced = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly url: string;
  private readonly samples: number;
  private readonly refreshMs: number;
  private readonly fetchFn: FetchLike;
  private readonly wallNow: () => number;
  private readonly perfNow: () => number;

  constructor(opts: ClockOptions = {}) {
    this.url = opts.url ?? '/api/time';
    this.samples = opts.samples ?? 5;
    this.refreshMs = opts.refreshMs ?? 5 * 60_000;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.wallNow = opts.wallNow ?? (() => Date.now());
    this.perfNow = opts.perfNow ?? (() => performance.now());
  }

  /** Server clock minus browser clock, in ms (0 until the first sync). */
  get offset(): number {
    return this.offsetMs;
  }

  /** Error bound of `offset` (half the best round trip); Infinity until synced. */
  get err(): number {
    return this.errMs;
  }

  get synced(): boolean {
    return this.isSynced;
  }

  /** The board's clock now (or at browser time `local`). */
  serverNow(local: number = this.wallNow()): number {
    return local + this.offsetMs;
  }

  /** How long ago board-clock time `t` was, clamped at 0; null when there is no `t`. */
  age(t: number | null | undefined, local: number = this.wallNow()): number | null {
    if (t === null || t === undefined || !Number.isFinite(t)) return null;
    return Math.max(0, local + this.offsetMs - t);
  }

  async sync(): Promise<boolean> {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < this.samples; i++) {
      try {
        const sentWall = this.wallNow();
        const sentPerf = this.perfNow();
        const res = await this.fetchFn(this.url, { cache: 'no-store' });
        const rtt = this.perfNow() - sentPerf;
        if (!res.ok) continue;
        const body = (await res.json()) as Partial<TimeResponse>;
        if (typeof body.now !== 'number' || !Number.isFinite(body.now)) continue;
        const offset = body.now - (sentWall + rtt / 2);
        if (best === null || rtt < best.rtt) best = { rtt, offset };
      } catch {
        // Try the next sample; a failed sync keeps the previous offset.
      }
    }
    if (best === null) return false;
    this.offsetMs = best.offset;
    this.errMs = best.rtt / 2;
    this.isSynced = true;
    return true;
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.refreshMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** The app's clock. */
export const clock = new ServerClock();
