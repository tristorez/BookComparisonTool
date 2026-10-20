/**
 * Server-Sent Events fan-out (Decisions.txt D-06..D-09). One stream per browser tab; every delta is
 * serialized once and the same bytes are written to every client.
 *
 * Invariants (see src/shared/wire.ts):
 * - A connection gets a snapshot or a replay of missed deltas first, then live deltas. Building that
 *   and attaching the client happen in one synchronous turn, so nothing is missed or doubled.
 * - Deltas are written to every client synchronously when the board emits them; heartbeats are written
 *   from a timer, so a heartbeat's `seq` is never ahead of the deltas already sent on that connection.
 */
import type { ServerResponse } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { parseSseId, sseId, type Delta, type Heartbeat } from '../shared/wire.js';
import type { Board } from './board.js';

export interface SseOptions {
  heartbeatMs?: number;
  /** A client this far behind is dropped; it reconnects and resumes or takes a snapshot. */
  maxBufferedBytes?: number;
  log?: (msg: string) => void;
}

interface Client {
  res: ServerResponse;
  connectedAt: number;
}

export class SseHub {
  private readonly clients = new Set<Client>();
  /** Serialized delta frames by seq, shared by the live broadcast and by resumes (oldest evicted first). */
  private readonly frames = new Map<number, string>();
  private readonly timer: NodeJS.Timeout;
  readonly counters = { connects: 0, resumes: 0, snapshots: 0, drops: 0, deltas: 0, bytes: 0, lastDeltaBytes: 0, lastSnapshotBytes: 0, maxDeltaBytes: 0 };

  constructor(
    private readonly board: Board,
    private readonly opts: SseOptions = {},
  ) {
    board.on('delta', (d) => this.broadcast(d));
    this.timer = setInterval(() => this.heartbeat(), opts.heartbeatMs ?? 5_000);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  handle(req: FastifyRequest, reply: FastifyReply): void {
    reply.hijack();
    const res = reply.raw;
    req.raw.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const header = req.headers['last-event-id'];
    const since = typeof header === 'string' ? header : ((req.query as { since?: string } | undefined)?.since ?? null);
    const from = parseSseId(since);
    const replay = from && from.boot === this.board.boot ? this.board.since(from.seq) : null;
    const snapshot = this.board.snapshotJson();
    const replayFrames = replay?.map((d) => this.frame(d));
    const replayBytes = replayFrames?.reduce((n, f) => n + f.length, 0) ?? Infinity;

    // Jittered retry spreads reconnect storms after a restart.
    let out = `retry: ${1_000 + Math.floor(Math.random() * 1_000)}\n\n`;
    if (replayFrames && replayBytes <= snapshot.json.length) {
      this.counters.resumes++;
      out += replayFrames.join('');
    } else {
      this.counters.snapshots++;
      this.counters.lastSnapshotBytes = snapshot.json.length;
      out += `id: ${sseId(this.board.boot, snapshot.seq)}\nevent: snapshot\ndata: ${snapshot.json}\n\n`;
    }
    out += this.heartbeatFrame();

    const client: Client = { res, connectedAt: Date.now() };
    this.counters.connects++;
    this.clients.add(client);
    res.on('close', () => this.clients.delete(client));
    this.write(client, out);
  }

  /** Stop heartbeats and end every stream (graceful shutdown; browsers reconnect elsewhere). */
  close(): void {
    clearInterval(this.timer);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }

  stats() {
    return { clients: this.clients.size, ...this.counters };
  }

  private frame(d: Delta): string {
    let f = this.frames.get(d.seq);
    if (!f) {
      f = `id: ${sseId(this.board.boot, d.seq)}\nevent: delta\ndata: ${JSON.stringify(d)}\n\n`;
      this.frames.set(d.seq, f);
      // Keep frames for the deltas the board can still replay.
      if (this.frames.size > 2_500) this.frames.delete(this.frames.keys().next().value!);
    }
    return f;
  }

  private broadcast(d: Delta): void {
    const f = this.frame(d);
    this.counters.deltas++;
    this.counters.lastDeltaBytes = f.length;
    this.counters.maxDeltaBytes = Math.max(this.counters.maxDeltaBytes, f.length);
    for (const c of this.clients) this.write(c, f);
  }

  private heartbeatFrame(): string {
    const hb: Heartbeat = { boot: this.board.boot, seq: this.board.seq, ts: Date.now(), status: this.board.status() };
    return `event: hb\ndata: ${JSON.stringify(hb)}\n\n`;
  }

  private heartbeat(): void {
    if (!this.clients.size) return;
    const f = this.heartbeatFrame();
    for (const c of this.clients) this.write(c, f);
  }

  private write(c: Client, data: string): void {
    if (c.res.writableLength > (this.opts.maxBufferedBytes ?? 1_000_000)) {
      this.counters.drops++;
      this.opts.log?.(`dropping a slow SSE client (${c.res.writableLength} bytes buffered)`);
      this.clients.delete(c);
      c.res.destroy();
      return;
    }
    this.counters.bytes += data.length;
    c.res.write(data);
  }
}
