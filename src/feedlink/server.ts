/**
 * Box A's end of the feed link: accepts Box B, checks its token, and exposes each of B's books to the
 * board as a feed. If the link drops or goes quiet for 5 s, B's feeds turn unhealthy at once and Box A
 * carries the books alone; B's next snapshot rebuilds its view.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import type { BookStatus, QuoteRef } from '../books/types.js';
import type { BookId } from '../shared/domain.js';
import type { Board, FeedHandle } from '../server/board.js';
import type { Endpoint } from '../server/config.js';
import type { LatencyTracker } from '../server/latency.js';
import { encode, LineSplitter, parseToBoard, type ToBoard, type ToFeed } from './protocol.js';

export interface FeedLinkServerOptions {
  board: Board;
  books: BookId[];
  token: string;
  latency?: LatencyTracker;
  log: (msg: string) => void;
  pingMs?: number;
  silenceMs?: number;
}

interface RemoteView {
  feed: string;
  book: BookId;
  status: BookStatus;
  handle: FeedHandle;
  /** What B currently lists, so a snapshot after a reconnect can remove what B dropped meanwhile. */
  quotes: Map<string, QuoteRef>;
  games: Set<string>;
}

const digest = (s: string) => createHash('sha256').update(s).digest();
const refKey = (r: QuoteRef) => `${r.gameKey}|${r.market}|${r.side}`;

export class FeedLinkServer {
  private server: Server | null = null;
  private readonly views = new Map<string, RemoteView>();
  private readonly links = new Map<string, { sock: Socket; boot: string; since: number }>();
  private readonly tokenDigest: Buffer;
  readonly counters = { connects: 0, rejected: 0, malformed: 0, messages: 0 };

  constructor(private readonly opts: FeedLinkServerOptions) {
    this.tokenDigest = digest(opts.token);
  }

  listen(ep: Endpoint): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((sock) => this.onConnection(sock));
      this.server.once('error', reject);
      this.server.listen(ep.port, ep.host, () => {
        this.opts.log(`feed link listening on ${ep.host}:${ep.port}`);
        resolve();
      });
    });
  }

  /** The bound port (useful with port 0 in tests). */
  get port(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : null;
  }

  close(): Promise<void> {
    for (const { sock } of this.links.values()) sock.destroy();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  /** Public (served in /api/health): no addresses here; the logs carry the peer's address. */
  status() {
    return {
      ...this.counters,
      links: [...this.links.entries()].map(([feed, l]) => ({ feed, boot: l.boot, since: l.since })),
    };
  }

  private onConnection(sock: Socket): void {
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);
    const splitter = new LineSplitter();
    let feed: string | null = null;
    let lastHeard = Date.now();
    const send = (m: ToFeed) => sock.writable && sock.write(encode(m));
    const helloTimer = setTimeout(() => this.reject(sock, 'no hello within 5s'), 5_000);
    const pingTimer = setInterval(() => {
      if (Date.now() - lastHeard > (this.opts.silenceMs ?? 5_000)) {
        this.opts.log(`feed link ${feed ?? '?'} silent, dropping`);
        sock.destroy();
        return;
      }
      send({ t: 'ping', at: Date.now() });
    }, this.opts.pingMs ?? 2_000);

    sock.on('data', (chunk) => {
      lastHeard = Date.now();
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch (err) {
        this.reject(sock, String(err));
        return;
      }
      for (const line of lines) {
        const m = parseToBoard(line, this.opts.books);
        if (!m) {
          this.counters.malformed++;
          continue;
        }
        this.counters.messages++;
        if (!feed) {
          if (m.t !== 'hello') return this.reject(sock, 'first message must be hello');
          feed = this.accept(sock, m, send);
          if (feed) clearTimeout(helloTimer);
          continue;
        }
        if (m.t !== 'hello') this.onMessage(feed, m);
      }
    });
    sock.on('error', (err) => this.opts.log(`feed link ${feed ?? '?'} error: ${err.message}`));
    sock.on('close', () => {
      clearTimeout(helloTimer);
      clearInterval(pingTimer);
      if (feed && this.links.get(feed)?.sock === sock) {
        this.links.delete(feed);
        this.opts.log(`feed link ${feed} closed`);
        for (const v of this.views.values()) if (v.feed === feed) v.handle.setLinked(false);
      }
    });
  }

  private accept(sock: Socket, hello: Extract<ToBoard, { t: 'hello' }>, send: (m: ToFeed) => unknown): string | null {
    if (!timingSafeEqual(digest(hello.token), this.tokenDigest)) {
      this.reject(sock, 'bad token');
      return null;
    }
    if (!/^[A-Za-z0-9_-]{1,16}$/.test(hello.feed)) {
      this.reject(sock, 'bad feed id');
      return null;
    }
    // A reconnect while the old socket is half-open: the new connection wins.
    const old = this.links.get(hello.feed);
    if (old) {
      this.opts.log(`feed link ${hello.feed} reconnected; replacing the previous connection`);
      this.links.delete(hello.feed);
      old.sock.destroy();
    }
    this.links.set(hello.feed, { sock, boot: hello.boot, since: Date.now() });
    this.counters.connects++;
    for (const book of hello.books.filter((b) => this.opts.books.includes(b))) this.view(hello.feed, book).handle.setLinked(true);
    send({ t: 'welcome', boot: this.opts.board.boot });
    this.opts.log(`feed link ${hello.feed} up from ${sock.remoteAddress} (boot ${hello.boot}, books ${hello.books.join(',')})`);
    return hello.feed;
  }

  private reject(sock: Socket, why: string): void {
    this.counters.rejected++;
    this.opts.log(`feed link rejected ${sock.remoteAddress}: ${why}`);
    if (sock.writable) sock.end(encode({ t: 'error', message: why }));
    setTimeout(() => sock.destroy(), 100).unref();
  }

  private view(feed: string, book: BookId): RemoteView {
    const key = `${feed}/${book}`;
    let v = this.views.get(key);
    if (v) return v;
    const status: BookStatus = { book, state: 'connecting', detail: 'waiting for the feed link', lastDataAt: null, lastChangeAt: null, since: Date.now() };
    const view: RemoteView = { feed, book, status, quotes: new Map(), games: new Set(), handle: undefined as unknown as FeedHandle };
    view.handle = this.opts.board.addFeed(feed, book, {
      getStatus: () => view.status,
      restart: () => {
        const link = this.links.get(feed);
        if (link?.sock.writable) link.sock.write(encode({ t: 'restart', book }));
      },
    });
    this.views.set(key, (v = view));
    return v;
  }

  private onMessage(feed: string, m: Exclude<ToBoard, { t: 'hello' }>): void {
    if (m.t === 'pong') return;
    const v = this.view(feed, m.book);
    const now = Date.now();
    if ('sentAt' in m) this.opts.latency?.record('linkLatency', { feed }, now - m.sentAt);
    switch (m.t) {
      case 'snapshot': {
        // Full resync: anything B listed before the reconnect but not now is gone.
        const quotes = new Map(m.quotes.map((q) => [refKey(q), { gameKey: q.gameKey, market: q.market, side: q.side }] as const));
        const removedQuotes = [...v.quotes.entries()].filter(([k]) => !quotes.has(k)).map(([, r]) => r);
        const games = new Set(m.games.map((g) => g.gameKey));
        const removedGames = [...v.games].filter((g) => !games.has(g));
        v.quotes = quotes;
        v.games = games;
        v.status = m.status;
        v.handle.status(m.status);
        v.handle.change({ book: m.book, games: m.games, removedGames, quotes: m.quotes, removedQuotes });
        break;
      }
      case 'change':
        for (const q of m.change.quotes) v.quotes.set(refKey(q), { gameKey: q.gameKey, market: q.market, side: q.side });
        for (const r of m.change.removedQuotes) v.quotes.delete(refKey(r));
        for (const g of m.change.games) v.games.add(g.gameKey);
        for (const g of m.change.removedGames) v.games.delete(g);
        v.handle.change(m.change);
        break;
      case 'samples':
        v.handle.samples(m.samples);
        break;
      case 'status':
        v.status = m.status;
        v.handle.status(m.status);
        break;
    }
  }
}
