import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent, ProxyAgent, type Dispatcher } from 'undici';
import type { Agent as HttpAgent } from 'node:http';

// Requests go through Node's built-in fetch, the same client scripts/probe-egress.mjs uses, so a
// passing probe predicts the connector: DraftKings' Akamai scores the HTTP client, not just the IP
// (README DK-10). The dispatcher comes from the `undici` package of the same major as Node's
// bundled copy (Node 24 → undici 7), which is what makes it compatible with the built-in fetch.

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

/**
 * Keep-alive dispatcher, optionally through an HTTP(S) proxy. Reusing warm connections matters:
 * a cold TLS handshake to a book's CDN costs more than the request itself.
 */
export function createDispatcher(proxyUrl?: string): Dispatcher {
  const opts = { keepAliveTimeout: 60_000, keepAliveMaxTimeout: 300_000, connections: 8 };
  return proxyUrl ? new ProxyAgent({ uri: proxyUrl, ...opts }) : new Agent(opts);
}

/** Agent for `ws` connections when egress must go through a proxy (e.g. DK blocks the host's IP range). */
export function createWsAgent(proxyUrl?: string): HttpAgent | undefined {
  return proxyUrl ? (new HttpsProxyAgent(proxyUrl) as unknown as HttpAgent) : undefined;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`HTTP ${status} from ${new URL(url).host}: ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
  }

  /** The book is refusing us (bot protection, WAF, rate limit) rather than failing; back off hard. */
  get blocked(): boolean {
    return this.status === 401 || this.status === 403 || this.status === 429;
  }
}

export const isBlocked = (err: unknown): err is HttpError => err instanceof HttpError && err.blocked;

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
  /** Epoch ms just before the request was sent. */
  sentAt: number;
  /** Epoch ms when the response headers arrived. */
  receivedAt: number;
}

export async function requestJson<T>(
  url: string,
  init: { dispatcher: Dispatcher; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<JsonResponse<T>> {
  const sentAt = Date.now();
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
    // `dispatcher` is Node's (undici's) extension to RequestInit.
    ...({ dispatcher: init.dispatcher } as RequestInit),
  });
  const receivedAt = Date.now();
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, url, text, parseRetryAfter(res.headers.get('retry-after')));
  try {
    return { data: JSON.parse(text) as T, headers: res.headers, sentAt, receivedAt };
  } catch {
    throw new HttpError(res.status, url, `unparseable JSON: ${text}`);
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Exponential backoff with equal jitter (between half and all of the capped ceiling). `attempt` starts at 1. */
export function backoffMs(attempt: number, baseMs = 1_000, maxMs = 30_000): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (Math.random() * ceiling) / 2);
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
