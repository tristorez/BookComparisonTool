/**
 * Box B's end of the feed link: streams every connector event to Box A as it happens. Nothing is
 * buffered while disconnected; on (re)connect each book's full snapshot resyncs Box A.
 */
import { randomUUID } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import type { BookConnector } from '../books/types.js';
import type { BookId } from '../shared/domain.js';
import type { Endpoint } from '../server/config.js';
import { encode, LineSplitter, parseToFeed, type ToBoard } from './protocol.js';

const isReady = (state: string) => state === 'live' || state === 'degraded';

export interface FeedLinkClientOptions {
  upstream: Endpoint;
  token: string;
  feedId: string;
  log: (msg: string) => void;
  /** `lastDataAt` moves silently, so status is re-sent this often. */
  statusEveryMs?: number;
  /** A link this far behind is dropped and resynced instead of queueing stale data. */
  maxBufferedBytes?: number;
}

export class FeedLinkClient {
  readonly boot = randomUUID().slice(0, 8);
  private readonly connectors = new Map<BookId, BookConnector>();
  private sock: Socket | null = null;
  private ready = false;
  private running = false;
  private attempt = 0;
  private statusTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly pendingSnapshot = new Set<BookId>();
  readonly counters = { connects: 0, sent: 0, dropped: 0, restarts: 0 };

  constructor(private readonly opts: FeedLinkClientOptions) {}

  attach(book: BookId, connector: BookConnector): void {
    this.connectors.set(book, connector);
    connector.on('change', (change) => this.send({ t: 'change', book, change, sentAt: Date.now() }));
    connector.on('sample', (samples) => this.send({ t: 'samples', book, samples, sentAt: Date.now() }));
    connector.on('status', (status) => {
      this.send({ t: 'status', book, status, sentAt: Date.now() });
      if (this.pendingSnapshot.has(book) && isReady(status.state)) this.sendSnapshot(book);
    });
  }

  /**
   * A snapshot is the book's full state, so send it only once the connector has bootstrapped: an empty
   * snapshot from a just-restarted box would read as "everything was removed". Fallback after 15 s.
   */
  private sendSnapshot(book: BookId): void {
    const c = this.connectors.get(book);
    if (!c || !this.ready) return;
    this.pendingSnapshot.delete(book);
    const snap = c.snapshot();
    this.send({ t: 'snapshot', book, games: snap.games, quotes: snap.quotes, status: snap.status, sentAt: Date.now() });
  }

  get linked(): boolean {
    return this.ready;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.statusTimer = setInterval(() => {
      for (const [book, c] of this.connectors) this.send({ t: 'status', book, status: c.status, sentAt: Date.now() });
    }, this.opts.statusEveryMs ?? 1_000);
  }

  stop(): void {
    this.running = false;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sock?.destroy();
  }

  private connect(): void {
    if (!this.running) return;
    const { host, port } = this.opts.upstream;
    const sock = connect({ host, port });
    this.sock = sock;
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 10_000);
    const splitter = new LineSplitter();
    sock.on('connect', () => {
      sock.write(encode({ t: 'hello', v: 1, feed: this.opts.feedId, boot: this.boot, token: this.opts.token, books: [...this.connectors.keys()] }));
    });
    sock.on('data', (chunk) => {
      let lines: string[];
      try {
        lines = splitter.push(chunk);
      } catch {
        sock.destroy();
        return;
      }
      for (const line of lines) {
        const m = parseToFeed(line);
        if (!m) continue;
        switch (m.t) {
          case 'welcome':
            this.ready = true;
            this.attempt = 0;
            this.counters.connects++;
            this.opts.log(`feed link up to ${host}:${port} (board boot ${m.boot}); sending snapshots`);
            for (const [book, c] of this.connectors) {
              this.pendingSnapshot.add(book);
              if (isReady(c.status.state)) this.sendSnapshot(book);
            }
            setTimeout(() => {
              for (const book of [...this.pendingSnapshot]) this.sendSnapshot(book);
            }, 15_000).unref();
            break;
          case 'ping':
            this.send({ t: 'pong', at: m.at });
            break;
          case 'restart':
            void this.restart(m.book);
            break;
          case 'error':
            this.opts.log(`board refused the feed link: ${m.message}`);
            break;
        }
      }
    });
    sock.on('error', (err) => this.opts.log(`feed link error: ${err.message}`));
    sock.on('close', () => {
      const was = this.ready;
      this.ready = false;
      if (this.sock === sock) this.sock = null;
      if (!this.running) return;
      const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempt++, 5));
      if (was) this.opts.log(`feed link down; reconnecting in ${delay}ms`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  /** The board saw this book's feed freeze while the other box kept moving: restart its connector. */
  private async restart(book: BookId): Promise<void> {
    const c = this.connectors.get(book);
    if (!c) return;
    this.counters.restarts++;
    this.opts.log(`board asked to restart ${book}`);
    await c.stop();
    await new Promise((r) => setTimeout(r, 2_000));
    await c.start();
  }

  private send(m: ToBoard): void {
    const sock = this.sock;
    if (!this.ready || !sock || !sock.writable) return;
    if (sock.writableLength > (this.opts.maxBufferedBytes ?? 4_000_000)) {
      this.counters.dropped++;
      this.opts.log('feed link backed up; dropping it to resync');
      sock.destroy();
      return;
    }
    this.counters.sent++;
    sock.write(encode(m));
  }
}
