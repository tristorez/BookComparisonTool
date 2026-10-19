/**
 * Latency series (Decisions.txt D-04/D-05): recent samples per (metric, book, phase, channel, feed),
 * reported as percentiles on demand. FanDuel's book timestamps are whole seconds, so its book→X
 * series are upper bounds: the true value lies in (raw − 1 s, raw]. `/api/metrics` carries each
 * book's resolution so every consumer can say so.
 */
import type { BookId, Channel, FeedId } from '../shared/domain.js';
import { MAX_BEACON_SAMPLES, type LatencyReport } from '../shared/wire.js';

const CHANNELS = new Set<unknown>(['snapshot', 'push', 'poll'] satisfies Channel[]);

export type Metric =
  | 'bookToServer' // first-copy receive − book timestamp
  | 'serverProcessing' // delta emitted − first-copy receive
  | 'secondCopyLag' // how far the slower feed trails the first copy
  | 'channelBookToServer' // every channel's own receive − book timestamp (not just the race winner's)
  | 'dkEngineToPublish' // DraftKings: publishedTime − createdTime (inside DK)
  | 'dkGatewayToServer' // DraftKings: our receive − websocketPublishTimestamp (network to our box)
  | 'linkLatency' // Box B send → Box A receive
  | 'serverToBrowser'
  | 'rxToBrowser'
  | 'bookToBrowser'
  | 'paint'
  | 'browserClockError'; // each beacon's clock-offset error bound (half its best /api/time round trip)

export interface Labels {
  book?: BookId;
  phase?: 'pre' | 'live';
  channel?: Channel;
  feed?: FeedId;
}

export interface Percentiles {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

class Reservoir {
  private readonly buf: number[] = [];
  private next = 0;
  total = 0;
  constructor(private readonly cap: number) {}
  push(v: number): void {
    this.total++;
    if (this.buf.length < this.cap) this.buf.push(v);
    else {
      this.buf[this.next] = v;
      this.next = (this.next + 1) % this.cap;
    }
  }
  stats(): Percentiles {
    const s = [...this.buf].sort((a, b) => a - b);
    const at = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
    return { n: s.length, min: s[0]!, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: s.at(-1)! };
  }
}

export class LatencyTracker {
  private readonly series = new Map<string, { metric: Metric; labels: Labels; r: Reservoir }>();
  /** First copies delivered per book × feed (which box wins the race). */
  private readonly firstCopies = new Map<string, number>();
  private readonly skewFloor = new Map<BookId, number>();
  /** Feeds the server itself has seen deliver a first copy; browser beacons may only label these. */
  private readonly knownFeeds = new Set<FeedId>();

  constructor(
    private readonly bookTimeResolutionMs: Partial<Record<BookId, number>> = {},
    private readonly cap = 5_000,
  ) {}

  record(metric: Metric, labels: Labels, ms: number): void {
    if (!Number.isFinite(ms)) return;
    const key = `${metric}|${labels.book ?? ''}|${labels.phase ?? ''}|${labels.channel ?? ''}|${labels.feed ?? ''}`;
    let s = this.series.get(key);
    if (!s) this.series.set(key, (s = { metric, labels, r: new Reservoir(this.cap) }));
    s.r.push(ms);
    if (metric === 'bookToServer' && labels.book) this.skewFloor.set(labels.book, Math.min(this.skewFloor.get(labels.book) ?? Infinity, ms));
  }

  firstCopy(book: BookId, feed: FeedId): void {
    const key = `${book}|${feed}`;
    this.knownFeeds.add(feed);
    this.firstCopies.set(key, (this.firstCopies.get(key) ?? 0) + 1);
  }

  /** Browser beacons: bounded and validated; malformed samples are dropped. */
  ingest(report: LatencyReport): number {
    if (report?.v !== 1 || !Array.isArray(report.samples)) return 0;
    // Every browser-side number below carries this error; keep its distribution next to them.
    if (typeof report.offsetErrMs === 'number' && Number.isFinite(report.offsetErrMs) && report.offsetErrMs >= 0 && report.offsetErrMs < 60_000) {
      this.record('browserClockError', {}, report.offsetErrMs);
    }
    let n = 0;
    for (const s of report.samples.slice(0, MAX_BEACON_SAMPLES)) {
      if (typeof s !== 'object' || !s || (s.phase !== 'pre' && s.phase !== 'live')) continue;
      // Labels come from the public internet: only known values may name a series, or arbitrary labels
      // would create series (each a 5,000-slot reservoir) without bound.
      if (s.book !== undefined && !Object.hasOwn(this.bookTimeResolutionMs, s.book)) continue; // not `in`: that accepts "constructor"
      if (s.ch !== undefined && !CHANNELS.has(s.ch)) continue;
      if (s.feed !== undefined && !this.knownFeeds.has(s.feed)) continue;
      const labels: Labels = { book: s.book, phase: s.phase, channel: s.ch, feed: s.feed };
      const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > -60_000 && v < 600_000;
      if (ok(s.serverToBrowser)) this.record('serverToBrowser', labels, s.serverToBrowser);
      if (ok(s.rxToBrowser)) this.record('rxToBrowser', labels, s.rxToBrowser);
      if (ok(s.bookToBrowser)) this.record('bookToBrowser', labels, s.bookToBrowser);
      if (ok(s.paint)) this.record('paint', labels, s.paint);
      n++;
    }
    return n;
  }

  snapshot() {
    return {
      note: 'FanDuel book timestamps are whole seconds: its book→X values are upper bounds; the true value lies in (raw − resolution, raw].',
      bookTimeResolutionMs: this.bookTimeResolutionMs,
      skewFloorMs: Object.fromEntries(this.skewFloor),
      firstCopies: Object.fromEntries(this.firstCopies),
      series: [...this.series.values()]
        .map(({ metric, labels, r }) => ({ metric, ...labels, total: r.total, ...r.stats() }))
        .sort((a, b) => `${a.metric}${a.book}${a.phase}${a.channel}${a.feed}`.localeCompare(`${b.metric}${b.book}${b.phase}${b.channel}${b.feed}`)),
    };
  }
}
