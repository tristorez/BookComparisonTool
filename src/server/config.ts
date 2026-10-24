/**
 * Environment → typed config, validated at boot (fail fast with a clear message). `npm run watch`
 * (src/scripts/watch.ts) builds its connectors from the same settings.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BOOK_IDS, type BookId } from '../shared/domain.js';
import type { FakeMode } from './fake.js';
import { BOOKS } from './registry.js';

export interface Endpoint {
  host: string;
  port: number;
}

export interface Config {
  /** `board` (Box A: connectors + board + site) or `feed` (Box B: connectors → feed link). */
  role: 'board' | 'feed';
  /** This box's feed id: "A" on the board box, "B" on the feed box. */
  feedId: string;
  http: Endpoint;
  books: BookId[];
  /** Synthetic books for offline dev, tests and load tests (`BOOKS=fake`). */
  fake: { seed: number; ratePerSec: number; modes: Partial<Record<BookId, FakeMode>> } | null;
  // Each book's own settings (its connector's options), from env vars prefixed with its short code.
  dk: { state: string; proxyUrl?: string; restProxyUrl?: string; wsProxyUrl?: string; tokenMode?: DkTokenMode };
  fd: { region: string; push: boolean; pollIntervalMs: number; pollPhaseMs: number; proxyUrl?: string; appKey?: string; pirKey?: string };
  /** Board: where Box B connects (private address only). */
  feedListen: Endpoint | null;
  /** Feed: Box A's private feed-link address. */
  feedUpstream: Endpoint | null;
  feedToken: string | null;
  staleGraceMs: number;
  staleAfterMs: Partial<Record<BookId, number>>;
  /** Board: how long one read of a game's player props (per book and group) is shared between viewers. */
  propsTtlMs: number;
  /** Dev-only book/feed stop/start routes, to demo the stale UI. Refused in production. */
  chaos: boolean;
  webDir: string;
  logLevel: string;
}

type DkTokenMode = 'default' | 'anonymous-jwt';

const FAKE_MODES: readonly FakeMode[] = ['normal', 'fail', 'freeze', 'garbage', 'massRemove'];
const DK_TOKEN_MODES: readonly DkTokenMode[] = ['default', 'anonymous-jwt'];

export class ConfigError extends Error {}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} must be an integer >= ${min}, got "${raw}"`);
  return n;
}

function endpoint(env: NodeJS.ProcessEnv, name: string): Endpoint | null {
  const raw = env[name];
  if (!raw) return null;
  const i = raw.lastIndexOf(':');
  const port = Number(raw.slice(i + 1));
  if (i <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError(`${name} must look like host:port, got "${raw}"`);
  return { host: raw.slice(0, i), port };
}

const opt = (v: string | undefined) => (v === undefined || v === '' ? undefined : v);

/**
 * Local runs of the board read ./.env (gitignored; see .env.example); variables already in the environment
 * win. Production takes its environment from systemd (/etc/odds/*.env) and never reads a stray .env.
 */
export function loadLocalEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production' && existsSync('.env')) process.loadEnvFile('.env');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const role = (env.ROLE ?? 'board') as Config['role'];
  if (role !== 'board' && role !== 'feed') throw new ConfigError(`ROLE must be "board" or "feed", got "${env.ROLE}"`);

  const booksRaw = (env.BOOKS ?? BOOK_IDS.join(',')).trim();
  const fakeAll = booksRaw === 'fake';
  const books = fakeAll ? [...BOOK_IDS] : (booksRaw.split(',').map((b) => b.trim()) as BookId[]);
  for (const b of books) if (!BOOK_IDS.includes(b)) throw new ConfigError(`BOOKS has unknown book "${b}" (known: ${BOOK_IDS.join(', ')}, or "fake")`);

  // Settings every book has, named by its short code: FAKE_MODE_DK, STALE_AFTER_FD_MS.
  const modes: Partial<Record<BookId, FakeMode>> = {};
  const staleAfterMs: Partial<Record<BookId, number>> = {};
  for (const b of BOOK_IDS) {
    const { short, staleAfterMs: fallback } = BOOKS[b];
    const m = env[`FAKE_MODE_${short}`] as FakeMode | undefined;
    if (m && !FAKE_MODES.includes(m)) throw new ConfigError(`FAKE_MODE_${short} must be one of ${FAKE_MODES.join(', ')}`);
    if (m) modes[b] = m;
    if (env[`STALE_AFTER_${short}_MS`]) staleAfterMs[b] = int(env, `STALE_AFTER_${short}_MS`, fallback, 1);
  }
  const dkTokenMode = opt(env.DK_TOKEN_MODE) as DkTokenMode | undefined;
  if (dkTokenMode && !DK_TOKEN_MODES.includes(dkTokenMode)) throw new ConfigError(`DK_TOKEN_MODE must be one of ${DK_TOKEN_MODES.join(', ')}`);

  const feedId = env.FEED_ID ?? (role === 'board' ? 'A' : 'B');
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(feedId)) throw new ConfigError(`FEED_ID must be 1-16 letters/digits, got "${feedId}"`);
  const feedListen = endpoint(env, 'FEED_LISTEN');
  const feedUpstream = endpoint(env, 'FEED_UPSTREAM');
  const feedToken = opt(env.FEED_TOKEN) ?? null;
  if (role === 'feed' && !feedUpstream) throw new ConfigError('ROLE=feed needs FEED_UPSTREAM (the board box private host:port)');
  if ((feedListen || role === 'feed') && (!feedToken || feedToken.length < 16)) throw new ConfigError('the feed link needs FEED_TOKEN (16+ characters)');

  const production = env.NODE_ENV === 'production';
  const chaos = env.CHAOS === '1';
  if (chaos && production) throw new ConfigError('CHAOS=1 is refused when NODE_ENV=production');

  return {
    role,
    feedId,
    http: { host: env.HOST ?? (production ? '127.0.0.1' : '0.0.0.0'), port: int(env, 'PORT', 8080, 1) },
    books,
    // FAKE_RATE ≥ 1: at 0 the fake book's tick would be Infinity ms, which setTimeout turns into 1 ms (a busy loop).
    fake: fakeAll ? { seed: int(env, 'FAKE_SEED', 7), ratePerSec: int(env, 'FAKE_RATE', 4, 1), modes } : null,
    dk: {
      state: env.DK_STATE ?? 'nj',
      proxyUrl: opt(env.DK_PROXY_URL),
      restProxyUrl: opt(env.DK_REST_PROXY_URL),
      wsProxyUrl: opt(env.DK_WS_PROXY_URL),
      tokenMode: dkTokenMode,
    },
    fd: {
      region: env.FD_REGION ?? 'nj',
      push: env.FD_PUSH !== '0',
      pollIntervalMs: int(env, 'FD_POLL_MS', 1_000),
      pollPhaseMs: int(env, 'FD_POLL_PHASE_MS', feedId === 'A' ? 0 : 500),
      proxyUrl: opt(env.FD_PROXY_URL),
      // Starting keys; a wrong one (FD_APP_KEY=x) shows the connector re-reading FD's live bundle.
      appKey: opt(env.FD_APP_KEY),
      pirKey: opt(env.FD_PIR_KEY),
    },
    feedListen,
    feedUpstream,
    feedToken,
    staleGraceMs: int(env, 'STALE_GRACE_MS', 5_000),
    staleAfterMs,
    propsTtlMs: int(env, 'PROPS_TTL_MS', 10_000, 1_000),
    chaos,
    // fileURLToPath, not URL.pathname: the latter percent-encodes spaces in the install path.
    webDir: env.WEB_DIR ?? fileURLToPath(new URL('../web/', import.meta.url)),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
