/**
 * Feed link between boxes (Decisions.txt D-34): Box B's connectors stream to Box A's board as
 * newline-delimited JSON over a private TCP connection. No buffering: after any reconnect, B sends a
 * full snapshot per book, so A rebuilds B's view instead of replaying a backlog.
 */
import { StringDecoder } from 'node:string_decoder';
import type { BookChange, BookGame, BookStatus, Quote, QuoteSample } from '../books/types.js';
import type { BookId } from '../shared/domain.js';

export const FEED_LINK_VERSION = 1;

/** Box B → Box A. */
export type ToBoard =
  | { t: 'hello'; v: typeof FEED_LINK_VERSION; feed: string; boot: string; token: string; books: BookId[] }
  | { t: 'snapshot'; book: BookId; games: BookGame[]; quotes: Quote[]; status: BookStatus; sentAt: number }
  | { t: 'change'; book: BookId; change: BookChange; sentAt: number }
  | { t: 'samples'; book: BookId; samples: QuoteSample[]; sentAt: number }
  | { t: 'status'; book: BookId; status: BookStatus; sentAt: number }
  | { t: 'pong'; at: number };

/** Box A → Box B. */
export type ToFeed = { t: 'welcome'; boot: string } | { t: 'ping'; at: number } | { t: 'restart'; book: BookId } | { t: 'error'; message: string };

export const encode = (m: ToBoard | ToFeed): string => `${JSON.stringify(m)}\n`;

/** Splits a byte stream into lines (UTF-8 safe across chunk boundaries); refuses oversized lines. */
export class LineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buf = '';

  constructor(private readonly maxLineBytes = 8 * 1024 * 1024) {}

  push(chunk: Buffer): string[] {
    this.buf += this.decoder.write(chunk);
    const lines = this.buf.split('\n');
    this.buf = lines.pop()!;
    if (this.buf.length > this.maxLineBytes) throw new Error(`feed link line exceeds ${this.maxLineBytes} bytes`);
    return lines.filter((l) => l.length > 0);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Shape check at the trust boundary; anything else is counted and dropped, and the link survives. */
export function parseToBoard(line: string, books: readonly BookId[]): ToBoard | null {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(m) || typeof m.t !== 'string') return null;
  const bookOk = () => typeof m.book === 'string' && books.includes(m.book as BookId);
  switch (m.t) {
    case 'hello':
      return m.v === FEED_LINK_VERSION && typeof m.feed === 'string' && typeof m.boot === 'string' && typeof m.token === 'string' && Array.isArray(m.books) ? (m as ToBoard) : null;
    case 'snapshot':
      return bookOk() && Array.isArray(m.games) && Array.isArray(m.quotes) && isObj(m.status) ? (m as ToBoard) : null;
    case 'change':
      return bookOk() && isObj(m.change) && Array.isArray(m.change.games) && Array.isArray(m.change.quotes) && Array.isArray(m.change.removedQuotes) && Array.isArray(m.change.removedGames) ? (m as ToBoard) : null;
    case 'samples':
      return bookOk() && Array.isArray(m.samples) ? (m as ToBoard) : null;
    case 'status':
      return bookOk() && isObj(m.status) ? (m as ToBoard) : null;
    case 'pong':
      return m as ToBoard;
    default:
      return null;
  }
}

export function parseToFeed(line: string): ToFeed | null {
  try {
    const m = JSON.parse(line) as unknown;
    return isObj(m) && typeof m.t === 'string' ? (m as ToFeed) : null;
  } catch {
    return null;
  }
}
