import type { Delta, Heartbeat, Snapshot } from '@shared/wire';
import { parseSseId, sseId } from './shared';
import type { ConnState, OddsStore } from './store';

/** The part of `EventSource` we use (tests pass a fake). */
export interface EventSourceLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (ev: Event) => void): void;
  close(): void;
}

export interface StreamOptions {
  store: OddsStore;
  url?: string;
  createEventSource?: (url: string) => EventSourceLike;
  /** No frame of any kind (snapshot, delta, heartbeat) for this long → recreate with `?since=`. */
  watchdogMs?: number;
  checkEveryMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  now?: () => number;
  perfNow?: () => number;
  isHidden?: () => boolean;
  /** Where `visibilitychange` is heard; null disables. */
  visibilityTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /** Real-time deltas only: not snapshots, not resume replays, not while the tab is hidden. */
  onLiveDelta?: (delta: Delta, receivedAt: number, receivedPerf: number) => void;
  log?: (message: string) => void;
}

type Mode = 'resume' | 'resync';

const ES_CLOSED = 2;

function parse<T>(data: unknown): T | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Keeps the store in step with the board's SSE stream (`snapshot`, `delta`, `hb`).
 *
 * Sequence rules (the server's per-connection order is snapshot or replay first, then live deltas with
 * heartbeats interleaved, and a heartbeat's `seq` is never ahead of the deltas written before it):
 * - snapshot: replaces all state and sets (boot, seq).
 * - delta: applied only if `seq === applied + 1`; `seq <= applied` is a duplicate and ignored; anything
 *   else is a gap → recreate with `?since=<boot>.<applied>`. The browser's own reconnect would resume
 *   from the last id it *received*, which after a gap is past what we applied, so we never rely on it.
 * - hb: other boot → resync (no `since`: get a snapshot); `seq` ahead of applied → resume; behind on
 *   the same boot (impossible by the invariants) → log and resync.
 * - Watchdog: no frame for 12 s → resume. Browser gave up (CLOSED, e.g. 502/503 in a deploy) → resume
 *   with backoff 1 s → 15 s. Back to a visible tab → check at once.
 */
export class StreamClient {
  private readonly store: OddsStore;
  private readonly url: string;
  private readonly createEventSource: (url: string) => EventSourceLike;
  private readonly watchdogMs: number;
  private readonly checkEveryMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly perfNow: () => number;
  private readonly isHidden: () => boolean;
  private readonly visibilityTarget: StreamOptions['visibilityTarget'];
  private readonly onLiveDelta: StreamOptions['onLiveDelta'];
  private readonly log: (message: string) => void;

  private es: EventSourceLike | null = null;
  private boot: string | null = null;
  private seq = 0;
  private state: ConnState = 'connecting';
  private inSync = false;
  private everSynced = false;
  /** Between (re)connecting and the first consistent heartbeat, deltas are catch-up, not live. */
  private replaying = true;
  private lastFrameAt = 0;
  private lastSyncedFrameAt: number | null = null;
  private attempts = 0;
  private pendingMode: Mode = 'resume';
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private checkTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(opts: StreamOptions) {
    this.store = opts.store;
    this.url = opts.url ?? '/api/stream';
    this.createEventSource = opts.createEventSource ?? ((url) => new EventSource(url));
    this.watchdogMs = opts.watchdogMs ?? 12_000;
    this.checkEveryMs = opts.checkEveryMs ?? 1_000;
    this.minBackoffMs = opts.minBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 15_000;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
    this.perfNow = opts.perfNow ?? (() => performance.now());
    this.isHidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
    this.visibilityTarget = opts.visibilityTarget !== undefined ? opts.visibilityTarget : typeof document !== 'undefined' ? document : null;
    this.onLiveDelta = opts.onLiveDelta;
    this.log = opts.log ?? ((message) => console.warn(`[stream] ${message}`));
  }

  /** Last applied position; null before the first snapshot. */
  get position(): { boot: string; seq: number } | null {
    return this.boot === null ? null : { boot: this.boot, seq: this.seq };
  }

  get connection(): ConnState {
    return this.state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.open('resume');
    this.checkTimer = setInterval(this.check, this.checkEveryMs);
    this.visibilityTarget?.addEventListener('visibilitychange', this.onVisibility);
  }

  stop(): void {
    this.running = false;
    this.closeSource();
    if (this.retryTimer !== undefined) clearTimeout(this.retryTimer);
    if (this.checkTimer !== undefined) clearInterval(this.checkTimer);
    this.retryTimer = undefined;
    this.checkTimer = undefined;
    this.visibilityTarget?.removeEventListener('visibilitychange', this.onVisibility);
  }

  private open(mode: Mode): void {
    this.retryTimer = undefined;
    this.closeSource();
    const since = mode === 'resume' && this.boot !== null ? sseId(this.boot, this.seq) : null;
    const url = since === null ? this.url : `${this.url}${this.url.includes('?') ? '&' : '?'}since=${encodeURIComponent(since)}`;
    const es = this.createEventSource(url);
    this.es = es;
    this.inSync = false;
    this.replaying = true;
    this.lastFrameAt = this.now(); // the watchdog times this attempt from here
    es.addEventListener('open', () => {
      if (this.es === es) this.replaying = true;
    });
    es.addEventListener('snapshot', (ev) => {
      if (this.es === es) this.onSnapshot(ev as MessageEvent<string>);
    });
    es.addEventListener('delta', (ev) => {
      if (this.es === es) this.onDelta(ev as MessageEvent<string>);
    });
    es.addEventListener('hb', (ev) => {
      if (this.es === es) this.onHeartbeat(ev as MessageEvent<string>);
    });
    es.addEventListener('error', () => {
      if (this.es === es) this.onError(es);
    });
  }

  private onSnapshot(ev: MessageEvent<string>): void {
    const at = this.now();
    this.lastFrameAt = at;
    const snap = parse<Snapshot>(ev.data);
    if (snap === null || typeof snap.boot !== 'string' || !Number.isSafeInteger(snap.seq)) {
      this.reconnect('resync', true, 'unreadable snapshot');
      return;
    }
    this.boot = snap.boot;
    this.seq = snap.seq;
    this.store.applySnapshot(snap);
    this.markInSync(at);
  }

  private onDelta(ev: MessageEvent<string>): void {
    const at = this.now();
    const atPerf = this.perfNow();
    this.lastFrameAt = at;
    if (this.boot === null) return; // nothing to apply it to; the server always leads with a snapshot
    const id = parseSseId(ev.lastEventId);
    if (id !== null && id.boot !== this.boot) {
      this.reconnect('resync', false, `delta from boot ${id.boot} while on ${this.boot}`);
      return;
    }
    const delta = parse<Delta>(ev.data);
    if (delta === null || !Number.isSafeInteger(delta.seq)) {
      this.reconnect('resume', false, 'unreadable delta');
      return;
    }
    if (delta.seq <= this.seq) return; // duplicate or replay overlap: already applied
    if (delta.seq !== this.seq + 1) {
      this.reconnect('resume', false, `gap: applied ${this.seq}, received ${delta.seq}`);
      return;
    }
    const live = !this.replaying && !this.isHidden();
    this.store.applyDelta(delta, { live });
    this.seq = delta.seq;
    if (this.inSync) this.lastSyncedFrameAt = at;
    if (live) this.onLiveDelta?.(delta, at, atPerf);
  }

  private onHeartbeat(ev: MessageEvent<string>): void {
    const at = this.now();
    this.lastFrameAt = at;
    const hb = parse<Heartbeat>(ev.data);
    if (hb === null || typeof hb.boot !== 'string' || !Number.isSafeInteger(hb.seq)) return;
    if (this.boot === null) return; // the snapshot comes first
    if (hb.boot !== this.boot) {
      this.reconnect('resync', false, `server restarted (boot ${this.boot} → ${hb.boot})`);
      return;
    }
    if (hb.seq > this.seq) {
      this.reconnect('resume', false, `heartbeat at ${hb.seq} but applied ${this.seq}`);
      return;
    }
    if (hb.seq < this.seq) {
      this.log(`heartbeat seq ${hb.seq} is behind applied ${this.seq} on boot ${hb.boot}; resyncing`);
      this.reconnect('resync', false);
      return;
    }
    if (Array.isArray(hb.status)) this.store.applyStatus(hb.status);
    this.replaying = false;
    this.markInSync(at);
  }

  private onError(es: EventSourceLike): void {
    this.inSync = false;
    this.replaying = true;
    this.setState(this.everSynced ? 'reconnecting' : 'connecting');
    // CONNECTING: the browser is retrying by itself (the server sets `retry:`) and sends Last-Event-ID.
    // CLOSED: it gave up (e.g. 502/503 while the server restarts), so we take over, backing off.
    if (es.readyState === ES_CLOSED) this.reconnect('resume', true, 'stream closed by the browser');
  }

  private markInSync(at: number): void {
    this.inSync = true;
    this.everSynced = true;
    this.attempts = 0;
    this.lastSyncedFrameAt = at;
    this.setState('open');
  }

  private reconnect(mode: Mode, backoff: boolean, reason?: string): void {
    if (!this.running) return;
    if (reason !== undefined) this.log(`reconnecting (${mode}): ${reason}`);
    this.closeSource();
    this.inSync = false;
    this.setState(this.everSynced ? 'reconnecting' : 'connecting');
    if (this.retryTimer !== undefined) {
      // A retry is already waiting out its backoff; a resync request upgrades it.
      if (mode === 'resync') this.pendingMode = 'resync';
      return;
    }
    const delay = backoff || this.attempts > 0 ? this.backoffDelay() : 0;
    this.attempts += 1;
    this.pendingMode = mode;
    if (delay === 0) this.open(mode);
    else this.retryTimer = setTimeout(() => this.open(this.pendingMode), delay);
  }

  /** 1 s, 2 s, 4 s, 8 s, then 15 s, each plus up to 20% jitter (capped) so tabs don't reconnect in lockstep. */
  private backoffDelay(): number {
    const base = this.minBackoffMs * 2 ** Math.min(this.attempts, 16);
    return Math.round(Math.min(this.maxBackoffMs, Math.min(this.maxBackoffMs, base) * (1 + 0.2 * this.random())));
  }

  private readonly check = (): void => {
    if (!this.running || this.es === null) return; // a retry is pending
    if (this.es.readyState === ES_CLOSED) {
      this.reconnect('resume', true, 'stream closed by the browser');
      return;
    }
    const silentFor = this.now() - this.lastFrameAt;
    if (silentFor > this.watchdogMs) this.reconnect('resume', false, `no frame for ${Math.round(silentFor / 1000)}s`);
  };

  private readonly onVisibility = (): void => {
    if (!this.running || this.isHidden()) return;
    if (this.es === null && this.retryTimer !== undefined) {
      // Back on screen while waiting out a backoff: try now.
      clearTimeout(this.retryTimer);
      this.open(this.pendingMode);
      return;
    }
    this.check();
  };

  private setState(state: ConnState): void {
    if (state === this.state) return;
    this.state = state;
    this.store.setConnection(state, this.lastSyncedFrameAt);
  }

  private closeSource(): void {
    const es = this.es;
    this.es = null;
    es?.close();
  }
}
