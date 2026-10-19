import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Delta } from '@shared/wire';
import { BOOT, GAME, delta, fakeEventSources, heartbeat, manualStore, quote, snapshot } from '../test/fixtures';
import { sseId } from './shared';
import type { OddsStore } from './store';
import { StreamClient } from './stream';

const T0 = Date.UTC(2026, 9, 25, 17, 0, 0);

describe('StreamClient', () => {
  let store: OddsStore;
  let es: ReturnType<typeof fakeEventSources>;
  let client: StreamClient;
  let logs: string[];
  let live: Delta[];
  let hidden: boolean;
  let visibility: EventTarget;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    store = manualStore();
    es = fakeEventSources();
    logs = [];
    live = [];
    hidden = false;
    visibility = new EventTarget();
    client = new StreamClient({
      store,
      createEventSource: es.factory,
      random: () => 0,
      isHidden: () => hidden,
      visibilityTarget: visibility,
      onLiveDelta: (d) => live.push(d),
      log: (m) => logs.push(m),
    });
    client.start();
  });

  afterEach(() => {
    client.stop();
    vi.useRealTimers();
  });

  /** Opens the current EventSource and plays snapshot + heartbeat at `seq`. */
  function connect(seq = 10) {
    const source = es.last();
    source.open();
    source.emit('snapshot', snapshot({ seq }), sseId(BOOT, seq));
    source.emit('hb', heartbeat(seq));
    return source;
  }

  const dkHome = (american: number) => [quote('draftkings', { american })];
  const dkAmerican = () => store.getQuote('draftkings', GAME, 'spread', 'home').quote?.american;

  it('connects without since, then applies a snapshot and consecutive deltas', () => {
    expect(es.created[0]?.url).toBe('/api/stream');
    expect(client.connection).toBe('connecting');
    const source = connect(10);
    expect(client.connection).toBe('open');
    expect(store.getConnection().state).toBe('open');
    source.emit('delta', delta(11, { quotes: dkHome(-105) }), sseId(BOOT, 11));
    source.emit('delta', delta(12, { quotes: dkHome(-102) }), sseId(BOOT, 12));
    expect(client.position).toEqual({ boot: BOOT, seq: 12 });
    expect(dkAmerican()).toBe(-102);
    expect(es.created).toHaveLength(1);
  });

  it('gap: drops the delta and resumes from the last applied seq with ?since=', () => {
    const source = connect(10);
    source.emit('delta', delta(11, { quotes: dkHome(-105) }), sseId(BOOT, 11));
    source.emit('delta', delta(13, { quotes: dkHome(-120) }), sseId(BOOT, 13));
    expect(source.closed).toBe(true);
    expect(es.created).toHaveLength(2);
    expect(es.last().url).toBe(`/api/stream?since=${BOOT}.11`);
    expect(client.position?.seq).toBe(11);
    expect(dkAmerican()).toBe(-105);
    expect(client.connection).toBe('reconnecting');

    // The server replays what we missed, then a heartbeat.
    const resumed = es.last();
    resumed.open();
    resumed.emit('delta', delta(12, { quotes: dkHome(-115) }), sseId(BOOT, 12));
    resumed.emit('delta', delta(13, { quotes: dkHome(-120) }), sseId(BOOT, 13));
    resumed.emit('hb', heartbeat(13));
    expect(client.position?.seq).toBe(13);
    expect(dkAmerican()).toBe(-120);
    expect(client.connection).toBe('open');
  });

  it('ignores duplicate and older deltas without reconnecting', () => {
    const source = connect(10);
    source.emit('delta', delta(11, { quotes: dkHome(-105) }), sseId(BOOT, 11));
    source.emit('delta', delta(11, { quotes: dkHome(-130) }), sseId(BOOT, 11));
    source.emit('delta', delta(9, { quotes: dkHome(-140) }), sseId(BOOT, 9));
    expect(dkAmerican()).toBe(-105);
    expect(client.position?.seq).toBe(11);
    expect(es.created).toHaveLength(1);
    expect(source.closed).toBe(false);
  });

  it('hb.boot change: resyncs without since to get a snapshot', () => {
    const source = connect(10);
    source.emit('hb', heartbeat(3, { boot: 'b2' }));
    expect(source.closed).toBe(true);
    expect(es.last().url).toBe('/api/stream');
    const fresh = es.last();
    fresh.open();
    fresh.emit('snapshot', snapshot({ boot: 'b2', seq: 3, quotes: dkHome(-125) }), sseId('b2', 3));
    expect(client.position).toEqual({ boot: 'b2', seq: 3 });
    expect(dkAmerican()).toBe(-125);
  });

  it('hb.seq ahead of applied: a real gap, so it resumes with since', () => {
    const source = connect(10);
    source.emit('delta', delta(11), sseId(BOOT, 11));
    source.emit('hb', heartbeat(12));
    expect(source.closed).toBe(true);
    expect(es.last().url).toBe(`/api/stream?since=${BOOT}.11`);
  });

  it('hb.seq behind applied on the same boot: logs and resyncs', () => {
    const source = connect(10);
    source.emit('delta', delta(11), sseId(BOOT, 11));
    source.emit('hb', heartbeat(10));
    expect(source.closed).toBe(true);
    expect(es.last().url).toBe('/api/stream');
    expect(logs.some((m) => m.includes('behind'))).toBe(true);
  });

  it('a delta whose id names another boot resyncs', () => {
    const source = connect(10);
    source.emit('delta', delta(11), sseId('b9', 11));
    expect(source.closed).toBe(true);
    expect(es.last().url).toBe('/api/stream');
  });

  it('ignores frames from an EventSource it already replaced', () => {
    const first = connect(10);
    first.emit('delta', delta(12), sseId(BOOT, 12)); // gap → replaced
    first.emit('delta', delta(11, { quotes: dkHome(-150) }), sseId(BOOT, 11));
    expect(dkAmerican()).toBeUndefined();
    expect(client.position?.seq).toBe(10);
  });

  it('watchdog: 12 s without any frame recreates the stream with since', () => {
    const source = connect(10);
    vi.advanceTimersByTime(8_000);
    source.emit('hb', heartbeat(10)); // heartbeats keep it alive
    vi.advanceTimersByTime(12_000);
    expect(es.created).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(source.closed).toBe(true);
    expect(es.created).toHaveLength(2);
    expect(es.last().url).toBe(`/api/stream?since=${BOOT}.10`);
  });

  it('CLOSED (browser gave up): recreates with since, backing off 1 s to 15 s, reset once in sync', () => {
    connect(10);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      es.last().fail(true);
      expect(client.connection).toBe('reconnecting');
      const before = es.created.length;
      let waited = 0;
      while (es.created.length === before && waited < 60_000) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
      expect(es.last().url).toBe(`/api/stream?since=${BOOT}.10`);
    }
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);

    const back = es.last();
    back.open();
    back.emit('hb', heartbeat(10));
    expect(client.connection).toBe('open');
    back.fail(true);
    vi.advanceTimersByTime(1_000);
    expect(es.created).toHaveLength(8);
  });

  it('CONNECTING error: leaves the retry to the browser (which sends Last-Event-ID)', () => {
    const source = connect(10);
    source.fail(false);
    expect(client.connection).toBe('reconnecting');
    vi.advanceTimersByTime(5_000);
    expect(es.created).toHaveLength(1);
    source.open();
    source.emit('delta', delta(11, { quotes: dkHome(-105) }), sseId(BOOT, 11));
    source.emit('hb', heartbeat(11));
    expect(client.connection).toBe('open');
    expect(dkAmerican()).toBe(-105);
  });

  it('back to a visible tab: checks freshness at once', () => {
    const source = connect(10);
    hidden = true;
    vi.setSystemTime(T0 + 30_000); // a frozen background tab: no timers ran
    visibility.dispatchEvent(new Event('visibilitychange'));
    expect(es.created).toHaveLength(1);
    hidden = false;
    visibility.dispatchEvent(new Event('visibilitychange'));
    expect(source.closed).toBe(true);
    expect(es.last().url).toBe(`/api/stream?since=${BOOT}.10`);
  });

  it('back to a visible tab while waiting out a backoff: retries now', () => {
    connect(10);
    es.last().fail(true);
    expect(es.created).toHaveLength(1);
    visibility.dispatchEvent(new Event('visibilitychange'));
    expect(es.created).toHaveLength(2);
  });

  it('only real-time deltas are live: not the replay before the first heartbeat, not while hidden', () => {
    const source = es.last();
    source.open();
    source.emit('snapshot', snapshot({ seq: 10 }), sseId(BOOT, 10));
    source.emit('delta', delta(11), sseId(BOOT, 11)); // before the heartbeat: catch-up
    source.emit('hb', heartbeat(11));
    source.emit('delta', delta(12), sseId(BOOT, 12));
    hidden = true;
    source.emit('delta', delta(13), sseId(BOOT, 13));
    hidden = false;
    source.emit('delta', delta(14), sseId(BOOT, 14));
    expect(live.map((d) => d.seq)).toEqual([12, 14]);

    // A browser reconnect replays again until its heartbeat.
    source.fail(false);
    source.open();
    source.emit('delta', delta(15), sseId(BOOT, 15));
    source.emit('hb', heartbeat(15));
    source.emit('delta', delta(16), sseId(BOOT, 16));
    expect(live.map((d) => d.seq)).toEqual([12, 14, 16]);
  });

  it('passes heartbeat status to the store', () => {
    const source = connect(10);
    source.emit('hb', heartbeat(10, { status: [{ ...heartbeat(10).status[0]!, stale: true }] }));
    expect(store.getEligibility().stale.has('draftkings')).toBe(true);
  });

  it('stop() closes the stream and schedules nothing more', () => {
    const source = connect(10);
    client.stop();
    expect(source.closed).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(es.created).toHaveLength(1);
  });
});
