import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BookConnector } from '../src/books/types.js';
import { FeedLinkClient } from '../src/feedlink/client.js';
import { FeedLinkServer } from '../src/feedlink/server.js';
import { buildApp } from '../src/server/app.js';
import { Board } from '../src/server/board.js';
import { FakeConnector } from '../src/server/fake.js';
import { LatencyTracker } from '../src/server/latency.js';
import { BOOKS } from '../src/server/registry.js';
import { SseHub } from '../src/server/sse.js';
import type { BookId } from '../src/shared/domain.js';
import type { Delta, Heartbeat, Snapshot, WireBest } from '../src/shared/wire.js';

type Ev = { event: string; id?: string; data: unknown };
const BOOK_IDS: BookId[] = ['draftkings', 'fanduel'];
const TOKEN = 'test-token-0123456789abcdef';

async function readSse(url: string, until: (evs: Ev[]) => boolean, opts: { headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Ev[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 5_000);
  const evs: Ev[] = [];
  try {
    const res = await fetch(url, { headers: opts.headers, signal: ac.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (!until(evs)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev: Partial<Ev> = {};
        for (const line of block.split('\n')) {
          const c = line.indexOf(': ');
          const [k, v] = c > 0 ? [line.slice(0, c), line.slice(c + 2)] : [line, ''];
          if (k === 'event') ev.event = v;
          else if (k === 'id') ev.id = v;
          else if (k === 'data') ev.data = JSON.parse(v);
        }
        if (ev.event) evs.push(ev as Ev);
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return evs;
}

const until = (ms: number, cond: () => boolean) =>
  new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const t = setInterval(() => {
      if (cond()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(t);
        reject(new Error('timed out'));
      }
    }, 25);
  });

describe('board over real sockets: SSE + feed link', () => {
  let board: Board;
  let hub: SseHub;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let url: string;
  let linkServer: FeedLinkServer;
  let link: FeedLinkClient;
  let tick: NodeJS.Timeout;
  const a = new Map<BookId, BookConnector>();
  const b = new Map<BookId, BookConnector>();

  beforeAll(async () => {
    const latency = new LatencyTracker();
    board = new Board({ books: [BOOKS.draftkings, BOOKS.fanduel], staleGraceMs: 300, staleAfterMs: { draftkings: 1_500, fanduel: 1_500 }, latency });
    for (const book of BOOK_IDS) {
      const c = new FakeConnector(book, { seed: 3, ratePerSec: 30 });
      const h = board.addFeed('A', book, { getStatus: () => c.status });
      c.on('change', h.change);
      c.on('sample', h.samples);
      c.on('status', h.status);
      a.set(book, c);
    }
    hub = new SseHub(board, { heartbeatMs: 200 });
    app = await buildApp({ board, hub, latency, cfg: { logLevel: 'error', chaos: false, webDir: '/nonexistent' }, logger: false });
    await app.listen({ host: '127.0.0.1', port: 0 });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    tick = setInterval(() => board.tick(), 100);

    linkServer = new FeedLinkServer({ board, books: BOOK_IDS, token: TOKEN, latency, log: () => {} });
    await linkServer.listen({ host: '127.0.0.1', port: 0 });
    link = new FeedLinkClient({ upstream: { host: '127.0.0.1', port: linkServer.port! }, token: TOKEN, feedId: 'B', log: () => {}, statusEveryMs: 200 });
    for (const book of BOOK_IDS) {
      const c = new FakeConnector(book, { seed: 3, ratePerSec: 30 });
      link.attach(book, c);
      b.set(book, c);
    }
    link.start();
    await Promise.all([...a.values(), ...b.values()].map((c) => c.start()));
    await until(5_000, () => board.health().feeds.filter((f) => f.healthy).length === 4);
  });

  afterAll(async () => {
    clearInterval(tick);
    link.stop();
    await Promise.all([...a.values(), ...b.values()].map((c) => c.stop()));
    hub.close();
    await linkServer.close();
    await app.close();
  });

  it('streams a snapshot, then consecutive deltas, with heartbeats never ahead of what was sent', async () => {
    const evs = await readSse(`${url}/api/stream`, (e) => e.filter((x) => x.event === 'delta').length >= 20 && e.some((x) => x.event === 'hb'));
    expect(evs[0]!.event).toBe('snapshot');
    const snap = evs[0]!.data as Snapshot;
    expect(evs[0]!.id).toBe(`${snap.boot}.${snap.seq}`);
    expect(snap.books.map((x) => x.id)).toEqual(BOOK_IDS);
    let last = snap.seq;
    for (const ev of evs.slice(1)) {
      if (ev.event === 'delta') {
        expect((ev.data as Delta).seq).toBe(last + 1);
        last = (ev.data as Delta).seq;
      } else if (ev.event === 'hb') {
        expect((ev.data as Heartbeat).seq).toBeLessThanOrEqual(last);
      }
    }
  });

  it('resumes from Last-Event-ID (and ?since=) without gaps; a different boot gets a snapshot', async () => {
    const first = await readSse(`${url}/api/stream`, (e) => e.filter((x) => x.event === 'delta').length >= 3);
    const lastId = first.filter((x) => x.event === 'delta').at(-1)!.id!;
    const seq = Number(lastId.split('.')[1]);
    // A resume replays what was missed (possibly nothing yet, so a heartbeat can come first) and never
    // sends a snapshot; the first delta must continue exactly where the client left off.
    const resumed = await readSse(`${url}/api/stream`, (e) => e.filter((x) => x.event === 'delta').length >= 3, { headers: { 'Last-Event-ID': lastId } });
    expect(resumed.some((x) => x.event === 'snapshot')).toBe(false);
    expect((resumed.find((x) => x.event === 'delta')!.data as Delta).seq).toBe(seq + 1);
    const viaQuery = await readSse(`${url}/api/stream?since=${encodeURIComponent(lastId)}`, (e) => e.some((x) => x.event === 'delta'));
    expect(viaQuery.some((x) => x.event === 'snapshot')).toBe(false);
    expect((viaQuery.find((x) => x.event === 'delta')!.data as Delta).seq).toBe(seq + 1);
    const otherBoot = await readSse(`${url}/api/stream`, (e) => e.length >= 1, { headers: { 'Last-Event-ID': 'deadbeef.5' } });
    expect(otherBoot[0]!.event).toBe('snapshot');
  });

  it('takes first copies from both boxes and keeps the board live when the feed link drops', async () => {
    const metrics = (await (await fetch(`${url}/api/metrics`)).json()) as { latency: { firstCopies: Record<string, number> } };
    expect(Object.keys(metrics.latency.firstCopies).some((k) => k.endsWith('|A'))).toBe(true);
    link.stop();
    await until(3_000, () => board.health().feeds.filter((f) => f.feed === 'B').every((f) => !f.healthy && !f.linked));
    for (const book of BOOK_IDS) expect(board.bookStatus(book).stale).toBe(false); // Box A still carries both books
  });

  it('marks a book stale only when every feed for it is down, and drops it from Best Price', async () => {
    await a.get('fanduel')!.stop(); // Box B's link is already down
    await until(3_000, () => board.bookStatus('fanduel').stale);
    expect(board.bookStatus('draftkings').stale).toBe(false);
    await until(2_000, () => {
      const bests = board.snapshot().bests.filter((x): x is Extract<WireBest, { none?: false }> => !x.none);
      return bests.length > 0 && bests.every((x) => !x.books.includes('fanduel'));
    });
    const health = (await (await fetch(`${url}/api/health`)).json()) as { books: { book: string; stale: boolean }[] };
    expect(health.books.find((x) => x.book === 'fanduel')!.stale).toBe(true);
  });
});
