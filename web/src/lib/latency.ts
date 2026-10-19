import { MAX_BEACON_SAMPLES, type Delta, type LatencyReport, type LatencySample } from '@shared/wire';

export interface ClockReading {
  readonly offset: number;
  readonly err: number;
  readonly synced: boolean;
}

type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export interface LatencyOptions {
  clock: ClockReading;
  /** Runs a callback in the frame that renders the delta (the store's next notification flush). */
  nextFrame: (cb: () => void) => void;
  url?: string;
  intervalMs?: number;
  /** Most samples per report; past it a uniform reservoir sample is kept. */
  cap?: number;
  send?: (url: string, body: string) => boolean;
  perfNow?: () => number;
  random?: () => number;
  isHidden?: () => boolean;
  /** Where `visibilitychange` (document) and `pagehide` (window) are heard; null disables. */
  events?: { document: Listenable; window: Listenable } | null;
}

function defaultSend(url: string, body: string): boolean {
  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    return navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
  }
  void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'application/json' } }).catch(() => {});
  return true;
}

/**
 * Measures the browser leg for every quote in every real-time delta and beacons a capped sample to
 * `POST /api/latency` every 15 s. All "→ browser" legs use the receive time on the board's clock
 * (browser time + offset), so they are comparable with the server's own `rx`/`ts` stamps.
 *   serverToBrowser = receive − delta.ts      rxToBrowser = receive − quote.rx
 *   bookToBrowser   = receive − quote.bt      paint       = receive → React's commit in the next frame
 * The stream never hands over snapshots, resume replays or hidden-tab deltas, and a frame that spans a
 * visibility change is dropped, so background throttling can't pollute the numbers.
 */
export class LatencyRecorder {
  private readonly clock: ClockReading;
  private readonly nextFrame: (cb: () => void) => void;
  private readonly url: string;
  private readonly intervalMs: number;
  private readonly cap: number;
  private readonly send: (url: string, body: string) => boolean;
  private readonly perfNow: () => number;
  private readonly random: () => number;
  private readonly isHidden: () => boolean;
  private readonly events: { document: Listenable; window: Listenable } | null;

  private samples: LatencySample[] = [];
  private seen = 0;
  private epoch = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: LatencyOptions) {
    this.clock = opts.clock;
    this.nextFrame = opts.nextFrame;
    this.url = opts.url ?? '/api/latency';
    this.intervalMs = opts.intervalMs ?? 15_000;
    this.cap = opts.cap ?? MAX_BEACON_SAMPLES;
    this.send = opts.send ?? defaultSend;
    this.perfNow = opts.perfNow ?? (() => performance.now());
    this.random = opts.random ?? Math.random;
    this.isHidden = opts.isHidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
    this.events =
      opts.events !== undefined ? opts.events : typeof window !== 'undefined' ? { document: window.document, window } : null;
  }

  /** `receivedAt` is browser `Date.now()` and `receivedPerf` is `performance.now()`, both at receive. */
  record(delta: Delta, receivedAt: number, receivedPerf: number): void {
    const quotes = delta.quotes;
    if (quotes === undefined || quotes.length === 0 || !this.clock.synced || this.isHidden()) return;
    const recv = receivedAt + this.clock.offset;
    const pending = quotes.map((q) => ({
      book: q.book,
      phase: q.live ? ('live' as const) : ('pre' as const),
      ch: q.ch,
      feed: q.feed,
      serverToBrowser: Math.round(recv - delta.ts),
      rxToBrowser: Math.round(recv - q.rx),
      bookToBrowser: typeof q.bt === 'number' ? Math.round(recv - q.bt) : null,
    }));
    const epoch = this.epoch;
    this.nextFrame(() => {
      // The store's flush has just notified React, which commits in a microtask queued by those
      // notifications; queueing ours afterwards measures up to the committed DOM of this frame.
      queueMicrotask(() => {
        if (epoch !== this.epoch) return; // the tab was hidden in between: this frame time means nothing
        const paint = Math.round((this.perfNow() - receivedPerf) * 10) / 10;
        for (const s of pending) this.add({ ...s, paint });
      });
    });
  }

  /** Samples waiting for the next report. */
  get size(): number {
    return this.samples.length;
  }

  /** Drains the buffer into a report; null when there is nothing to send or no clock offset yet. */
  takeReport(): LatencyReport | null {
    if (this.samples.length === 0 || !this.clock.synced) return null;
    const report: LatencyReport = {
      v: 1,
      offsetMs: Math.round(this.clock.offset * 10) / 10,
      offsetErrMs: Math.round(this.clock.err * 10) / 10,
      samples: this.samples,
    };
    this.samples = [];
    this.seen = 0;
    return report;
  }

  flush(): boolean {
    const report = this.takeReport();
    if (report === null) return false;
    try {
      return this.send(this.url, JSON.stringify(report));
    } catch {
      return false;
    }
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
    this.events?.document.addEventListener('visibilitychange', this.onVisibility);
    this.events?.window.addEventListener('pagehide', this.onPageHide);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.events?.document.removeEventListener('visibilitychange', this.onVisibility);
    this.events?.window.removeEventListener('pagehide', this.onPageHide);
  }

  private add(s: LatencySample): void {
    this.seen += 1;
    if (this.samples.length < this.cap) {
      this.samples.push(s);
      return;
    }
    const j = Math.floor(this.random() * this.seen);
    if (j < this.cap) this.samples[j] = s;
  }

  private readonly onVisibility = (): void => {
    this.epoch += 1;
    if (this.isHidden()) this.flush(); // the tab may be discarded while hidden
  };

  private readonly onPageHide = (): void => {
    this.flush();
  };
}
