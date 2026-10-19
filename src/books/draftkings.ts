import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Dispatcher } from 'undici';
import { BROWSER_UA, backoffMs, createDispatcher, createWsAgent, isBlocked, requestJson, sleep, type JsonResponse } from './http.js';
import { americanToDecimal, decimalToAmerican, parseAmerican } from './odds.js';
import { gameKey, resolveTeam } from './teams.js';
import {
  BookConnector,
  quoteKey,
  type BookChange,
  type BookGame,
  type Channel,
  type MarketType,
  type Quote,
  type QuoteRef,
  type Side,
} from './types.js';

/**
 * DraftKings connector.
 *
 * DK's web client (its `dk-data-layer` bundle) loads a REST snapshot of the board and then
 * receives deltas on a JSON-RPC 2.0 WebSocket:
 *  - REST  sportsbook-nash.draftkings.com/api/sportscontent/{site}/v1/leagues/{league}/categories/{cat}/subcategories/{sub}
 *          → events/markets/selections plus `subscriptionPartials`, the exact socket query to send.
 *  - WS    wss://sportsbook-ws-{cc}-{st}.draftkings.com/websocket?format=json&locale=en
 *          → `subscribe` with jwt "default-token" (DK's anonymous token provider literally returns
 *          that string); frames carry add/change/remove lists. `change` objects are partial, so we
 *          keep full state and merge. Nothing is replayed after a reconnect and `initialData: true`
 *          is ignored (verified), so every (re)connect re-snapshots over REST, and a periodic REST
 *          reconcile bounds drift from any lost frame.
 * DK's site uses `format=msgpack` with positional arrays; JSON carries the same frames with named
 * fields, so a schema change cannot silently shift a price into the wrong slot.
 */

const NFL_LEAGUE = '88808';
const GAME_LINES_CATEGORY = '492';
const GAME_LINES_SUBCATEGORY = '4518'; // "Game Lines → Game": main moneyline/spread/total
const CLIENT_VERSION = '2640.4.1.8'; // DK web build seen in Oct 2026; informational only
/**
 * The odds socket's `jwt`. DK's own web client sends the literal "default-token", and the socket does
 * not validate it: "default-token", a real anonymous JWT, a garbage string and no token at all were all
 * subscribed (tested 2026-10-19). If DK ever starts enforcing it, the connector switches to the
 * anonymous enterprise JWT DK's own widgets fetch (`generateAnonymousEnterpriseJWT`: no cookies,
 * 120 s lifetime), renewed on DK's own schedule and sent the way DK's client sends it.
 */
const DEFAULT_TOKEN = 'default-token';
/** Consecutive subscription refusals in default-token mode before switching to the anonymous JWT. */
const TOKEN_REJECTIONS_BEFORE_JWT = 2;
/** DK's token manager schedule: renew at 90% of `expiresIn`, 3 tries 2 s apart. */
const JWT_RENEW_AT = 0.9;
const JWT_FETCH_ATTEMPTS = 3;
const JWT_RETRY_MS = 2_000;
/** A subscription the server drops this soon after we sent it counts as a refusal. */
const EARLY_UNSUBSCRIBE_MS = 10_000;
/** DK's own EVENT_STATES enum (from its client bundle). */
const KNOWN_EVENT_STATUSES = new Set(['NOT_STARTED', 'STARTED', 'FINISHED']);

// Liveness: DK answers pings in ~30 ms, so a ping every 5 s with a 12 s silence limit catches a dead
// socket (half-open TCP, stalled edge) within ~13 s instead of leaving the board silently stale.
const WATCHDOG_TICK_MS = 1_000;
const PING_EVERY_TICKS = 5;
const SILENCE_TIMEOUT_MS = 12_000;
const SUBSCRIBE_ACK_TIMEOUT_MS = 10_000;
// Reconnects: retry fast once (most drops are transient), back off exponentially if the socket keeps
// failing, and back off much harder when DK's CDN is actively refusing us.
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const BLOCKED_BASE_MS = 30_000;
const BLOCKED_MAX_MS = 600_000;

const SNAPSHOT_TIMEOUT_MS = 5_000;
const SNAPSHOT_RETRY_MAX_MS = 10_000;
/**
 * The bootstrap snapshot is fetched in parallel with the socket handshake, and DK's REST is
 * edge-cached ~1 s, so it can predate the subscription slightly; a quick resync closes that gap
 * without delaying the first prices.
 */
const RESYNC_AFTER_BOOTSTRAP_MS = 2_000;
/** Frames older than this when the snapshot arrives are already reflected in it. */
const BUFFER_HORIZON_MS = 10_000;
/**
 * During a reconcile, anything a frame touched this recently keeps the socket's value. REST may
 * trail the push pipeline (edge cache, origin replicas); a lost frame is still corrected on the
 * next reconcile, while a too-short window could roll a fresh price back.
 */
const RECONCILE_TRUST_WINDOW_MS = 10_000;
/** After a reconnect with REST unavailable, the last board may stand in (flagged degraded) only if we were live this recently. */
const MAX_DEGRADED_GAP_MS = 120_000;
/**
 * A snapshot that would drop more than this share of the board at once is held until a snapshot
 * fetched at least MASS_DROP_CONFIRM_MS later agrees. DK removes finished games over the socket
 * one at a time, so a sudden mass drop via REST is far likelier a bad read; requiring agreement
 * across time (not just the next read, which may be the 2 s post-bootstrap resync) keeps two
 * back-to-back bad reads from blanking the board.
 */
const MASS_DROP_FRACTION = 0.3;
const MASS_DROP_CONFIRM_MS = 30_000;
/**
 * Pongs prove the socket is alive, not that our subscription still flows. Live NFL markets move
 * every few seconds, so this long without an update frame while a game is live means the
 * subscription went quiet; resubscribe (make-before-break).
 */
const LIVE_SUBSCRIPTION_SILENCE_MS = 45_000;
/** A reconcile that had to correct this many quotes outside the trust window also triggers a resubscribe. */
const RECONCILE_DRIFT_RESUBSCRIBE = 3;
/** Partial changes for selections we have not seen yet (they can precede the `add`) are held this long. */
const ORPHAN_TTL_MS = 10_000;
/** DK moves a line as remove(old) then add(new) a few ms apart; keep showing the old line until then. */
const REPLACEMENT_GRACE_MS = 1_000;

const MARKET_SIDES: Record<MarketType, Side[]> = { moneyline: ['away', 'home'], spread: ['away', 'home'], total: ['over', 'under'] };
const OUTCOME_SIDES: Record<string, Side> = { Home: 'home', Away: 'away', Over: 'over', Under: 'under' };

interface DkParticipant {
  name?: string;
  venueRole?: string;
  metadata?: { shortName?: string; rosettaTeamName?: string };
}
interface DkEvent {
  id: string;
  name?: string;
  startEventDate?: string;
  status?: string;
  participants?: DkParticipant[];
}
interface DkMarket {
  id: string;
  eventId?: string;
  name?: string;
  marketType?: { name?: string; betOfferTypeId?: number };
  isSuspended?: boolean;
}
interface DkSelection {
  id: string;
  marketId?: string;
  label?: string;
  displayOdds?: { american?: string; decimal?: string };
  trueOdds?: number;
  points?: number | null;
  outcomeType?: string;
  main?: boolean;
  tags?: string[];
}
interface DkSubscriptionPartial {
  entity?: string;
  query?: string;
  includeMarkets?: string;
}
interface DkSnapshot {
  events: DkEvent[];
  markets: DkMarket[];
  selections: DkSelection[];
  subscriptionPartials?: Record<string, DkSubscriptionPartial>;
}
interface DkEntityLists<E, M, S> {
  events?: E[];
  markets?: M[];
  selections?: S[];
}
interface DkFrame {
  id?: string;
  event?: string;
  data?:
    | {
        data?: {
          add?: DkEntityLists<DkEvent, DkMarket, DkSelection>;
          change?: DkEntityLists<DkEvent, DkMarket, DkSelection>;
          remove?: DkEntityLists<string, string, string>;
        };
        metadata?: { createdTime?: string; publishedTime?: string };
      }
    | string;
  /** When DK's socket gateway sent the frame. */
  websocketPublishTimestamp?: string;
  error?: unknown;
}

/** DK's three timestamps for one frame: engine change, pipeline publish, gateway send. */
interface FrameTimes {
  createdAt: number | null;
  publishedAt: number | null;
  gatewayAt: number | null;
}

/** An entity plus when a socket frame last touched it (0 = REST only), for snapshot merges. */
interface Tracked<T> {
  v: T;
  rx: number;
  /** Insertion order, to prefer the newest selection while a line move is mid-flight. */
  seq: number;
}

/** Entities touched by one frame or snapshot, recomputed together into one change batch. */
interface Batch {
  events: Set<string>;
  markets: Set<string>;
  removedQuotes: QuoteRef[];
}

export interface DraftKingsOptions {
  /** Jurisdiction, e.g. "nj" → site `dkusnj`, socket `sportsbook-ws-us-nj`. */
  state?: string;
  country?: 'us' | 'ca';
  leagueId?: string;
  subcategoryId?: string;
  /** Full REST reconcile cadence. DK sends deltas only and has no sequence numbers, so this bounds drift. */
  reconcileIntervalMs?: number;
  /** Egress proxy for both channels. */
  proxyUrl?: string;
  /** Proxy for the REST snapshot only (Akamai Bot Manager on sportsbook-nash rejects more IP ranges than the socket host). */
  restProxyUrl?: string;
  /** Proxy for the socket only. */
  wsProxyUrl?: string;
  /** Endpoint overrides, for tests or replay servers. */
  restUrl?: string;
  wsUrl?: string;
  /** Socket token: DK's literal "default-token" (what its site sends), or its anonymous JWT. Switches to the JWT on its own if DK refuses the default. */
  tokenMode?: 'default' | 'anonymous-jwt';
  /** Anonymous JWT endpoint override, for tests. */
  tokenUrl?: string;
}

export class DraftKingsConnector extends BookConnector {
  readonly book = 'draftkings' as const;

  private readonly siteName: string;
  private readonly restUrl: string;
  private readonly wsUrl: string;
  private readonly reconcileIntervalMs: number;
  private readonly wsProxyUrl: string | undefined;
  private readonly http: Dispatcher;
  private readonly leagueId: string;
  private readonly subcategoryId: string;

  private readonly events = new Map<string, Tracked<DkEvent>>();
  private readonly markets = new Map<string, Tracked<DkMarket>>();
  private readonly selections = new Map<string, Tracked<DkSelection>>();
  private readonly marketsByEvent = new Map<string, Set<string>>();
  private readonly selectionsByMarket = new Map<string, Set<string>>();
  /** Games we have emitted, by DK event id. */
  private readonly emittedGames = new Map<string, BookGame>();
  private readonly orphans = new Map<string, { patch: DkSelection; rx: number; t: number | null }>();
  /** Recently removed ids → removal time, so a stale snapshot cannot resurrect them during a reconcile. */
  private readonly tombstones = new Map<string, number>();
  private readonly pendingRemovals = new Map<string, { ref: QuoteRef; marketId: string; at: number }>();
  private readonly unknownStatuses = new Set<string>();
  private readonly unresolvedEvents = new Set<string>();
  private seq = 0;

  private readonly timers = new Set<NodeJS.Timeout>();
  private running = false;
  private ws: WebSocket | null = null;
  /** Incremented per connection; async work started under an older epoch is discarded. */
  private epoch = 0;
  private wsAttempt = 0;
  private wsLastSeenAt = 0;
  /** Frames apply directly once ready; before that they are buffered for replay over the snapshot. */
  private ready = false;
  private lastReadyAt = 0;
  private lastUpdateFrameAt = 0;
  private lastResubscribeAt = 0;
  /** Bootstrap timing for the current connection, for the startup log. */
  private connectStartedAt = 0;
  private ackAt = 0;
  private snapshotAt = 0;
  private bootstrapping = false;
  private reconciling = false;
  private lastSnapshotSentAt = 0;
  /** When a snapshot first asked to drop most of the board; cleared as soon as one doesn't. */
  private massDropSince: number | null = null;
  private buffered: { frame: DkFrame; rx: number }[] = [];
  private subscription: { id: string; partial: DkSubscriptionPartial } | null = null;
  private subscribedAt = 0;
  private restFailures = 0;

  private tokenMode: 'default' | 'anonymous-jwt';
  private readonly tokenUrl: string;
  private jwt = DEFAULT_TOKEN;
  /** When the current JWT is due for renewal (0 until one is fetched). */
  private jwtRenewAt = 0;
  private jwtFetch: Promise<void> | null = null;
  private jwtTimer: NodeJS.Timeout | undefined;
  private tokenRejections = 0;

  constructor(opts: DraftKingsOptions = {}) {
    super();
    const state = (opts.state ?? 'nj').toLowerCase();
    const country = opts.country ?? 'us';
    this.siteName = `dk${country}${state}`;
    this.leagueId = opts.leagueId ?? NFL_LEAGUE;
    this.subcategoryId = opts.subcategoryId ?? GAME_LINES_SUBCATEGORY;
    this.restUrl =
      opts.restUrl ??
      `https://sportsbook-nash.draftkings.com/api/sportscontent/${this.siteName}/v1/leagues/${this.leagueId}/categories/${GAME_LINES_CATEGORY}/subcategories/${this.subcategoryId}`;
    this.wsUrl = opts.wsUrl ?? `wss://sportsbook-ws-${country}-${state}.draftkings.com/websocket?format=json&locale=en`;
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? 60_000;
    this.wsProxyUrl = opts.wsProxyUrl ?? opts.proxyUrl;
    this.http = createDispatcher(opts.restProxyUrl ?? opts.proxyUrl);
    this.tokenMode = opts.tokenMode ?? 'default';
    this.tokenUrl = opts.tokenUrl ?? `https://gaming-${country}-${state}.draftkings.com/api/wager/v1/generateAnonymousEnterpriseJWT`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.setStatus('connecting');
    if (this.tokenMode === 'anonymous-jwt') await this.renewJwt();
    this.connect();
    this.every(this.reconcileIntervalMs, () => this.reconcile());
    this.every(250, () => this.housekeeping());
  }

  async stop(): Promise<void> {
    this.running = false;
    this.epoch++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.ws?.close(1000);
    this.ws = null;
    this.setStatus('stopped');
  }

  // ---------------------------------------------------------------- socket

  private connect(): void {
    if (!this.running || this.ws) return;
    const epoch = ++this.epoch;
    this.ready = false;
    this.buffered = [];
    this.subscription = null;
    // The snapshot request runs in parallel with the socket handshake; it is applied once the
    // subscription is acknowledged, so first prices don't wait for the two in sequence.
    this.connectStartedAt = Date.now();
    this.ackAt = 0;
    this.snapshotAt = 0;
    const firstSnapshot = this.fetchSnapshot();
    firstSnapshot.then(
      () => (this.snapshotAt = Date.now()),
      () => {}, // consumed by bootstrap; this only silences an early unhandled rejection
    );
    // In JWT mode the token also rides on the connection URL, as DK's data layer does on token renewal.
    const url = this.tokenMode === 'anonymous-jwt' ? `${this.wsUrl}&jwt=${encodeURIComponent(this.jwt)}` : this.wsUrl;
    const ws = new WebSocket(url, {
      headers: { Origin: 'https://sportsbook.draftkings.com', 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      agent: createWsAgent(this.wsProxyUrl),
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    // After stop()/start() or a reconnect, an old socket's late events must not touch the new connection's state.
    const current = () => this.epoch === epoch && this.ws === ws;
    let watchdog: NodeJS.Timeout | undefined;
    let ackTimer: NodeJS.Timeout | undefined;
    let acked = false;
    let openedAt = 0;
    let rejectedStatus: number | undefined;
    // DK can refuse a subscription with an error frame, an early unsubscribe and a 4000 close; count it once per connection.
    let refused = false;
    const refuse = (reason: string) => {
      if (refused) return;
      refused = true;
      this.onTokenRejected(reason);
    };

    ws.on('unexpected-response', (_req, res) => {
      // Akamai answers a denied upgrade with a plain HTTP 403 page; surface it instead of a bare socket error.
      rejectedStatus = res.statusCode;
      if (current()) this.log(`socket upgrade rejected: HTTP ${res.statusCode} (${res.headers.server ?? 'unknown server'})`);
      ws.terminate();
    });
    ws.on('open', () => {
      if (!current()) return;
      openedAt = this.wsLastSeenAt = this.lastUpdateFrameAt = Date.now();
      // DK closes a socket "inactive for 5000 ms" (close 4002), so subscribe immediately.
      this.subscribe(ws, this.defaultPartial());
      ackTimer = setTimeout(() => {
        if (acked) return;
        this.log('no subscribe acknowledgement, reconnecting');
        ws.terminate();
      }, SUBSCRIBE_ACK_TIMEOUT_MS);
      let ticks = 0;
      watchdog = setInterval(() => {
        if (!current()) return clearInterval(watchdog);
        if (Date.now() - this.wsLastSeenAt > SILENCE_TIMEOUT_MS) {
          this.log(`socket silent for ${SILENCE_TIMEOUT_MS / 1000}s, terminating`);
          ws.terminate();
          return;
        }
        if (++ticks % PING_EVERY_TICKS === 0) ws.ping();
      }, WATCHDOG_TICK_MS);
    });
    ws.on('pong', () => {
      if (!current()) return;
      this.wsLastSeenAt = Date.now();
      this.touch(this.wsLastSeenAt);
    });
    ws.on('message', (raw) => {
      if (!current()) return;
      const rx = Date.now();
      this.wsLastSeenAt = rx;
      let frame: DkFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        this.log(`unparseable frame: ${raw.toString().slice(0, 200)}`);
        return;
      }
      this.touch(rx);
      switch (frame.event) {
        case 'update':
          this.lastUpdateFrameAt = rx;
          if (this.ready) this.applyFrame(frame, rx);
          else {
            this.buffered.push({ frame, rx });
            while (this.buffered.length && rx - this.buffered[0]!.rx > BUFFER_HORIZON_MS) this.buffered.shift();
          }
          return;
        case 'subscribed':
          if (!acked) {
            acked = true;
            this.ackAt = rx;
            void this.bootstrap(ws, epoch, firstSnapshot);
          }
          return;
        case 'unsubscribed':
          if (frame.id && frame.id === this.subscription?.id) {
            if (Date.now() - this.subscribedAt < EARLY_UNSUBSCRIBE_MS) {
              refuse('server dropped our subscription right after we sent it');
              ws.terminate();
              return;
            }
            this.log('server dropped our subscription, resubscribing');
            this.subscribe(ws, this.subscription.partial);
          }
          return;
        default:
          this.log(`frame ${frame.event ?? '?'}: ${JSON.stringify(frame).slice(0, 300)}`);
          if (frame.event === 'error' || frame.error) {
            refuse('subscription refused');
            ws.terminate();
          }
      }
    });
    ws.on('error', (err) => {
      if (current()) this.log(`socket error: ${err.message}`);
    });
    ws.on('close', (code, reason) => {
      clearInterval(watchdog);
      clearTimeout(ackTimer);
      if (!current()) return;
      this.ws = null;
      if (this.ready) this.lastReadyAt = Date.now();
      this.ready = false;
      if (!this.running) return;
      if (openedAt && Date.now() - openedAt > STABLE_CONNECTION_MS) this.wsAttempt = 0;
      // DK's own close-code table: 4000 is "insufficient params … such as jwt".
      if (code === 4000) refuse('socket closed 4000 (insufficient params)');
      const attempt = ++this.wsAttempt;
      const blocked = rejectedStatus === 401 || rejectedStatus === 403 || rejectedStatus === 429;
      // A refusal (a 4000 close included) is handled by changing the token, so it retries on the normal
      // backoff, which still grows if DK keeps refusing; only 4001/1013 carry a floor.
      const delay = blocked
        ? backoffMs(attempt, BLOCKED_BASE_MS, BLOCKED_MAX_MS)
        : Math.max(closeFloorMs(code), backoffMs(attempt, RECONNECT_BASE_MS, RECONNECT_MAX_MS));
      const why = blocked
        ? `blocked by DraftKings (HTTP ${rejectedStatus})`
        : rejectedStatus
          ? `socket upgrade failed (HTTP ${rejectedStatus})`
          : `socket closed (${code}${reason.length ? ` ${reason.toString()}` : ''})`;
      const next = refused ? `; subscription refused, retrying with ${this.tokenMode === 'anonymous-jwt' ? "a fresh anonymous JWT" : 'the default token'}` : '';
      this.log(`${why}${next}, reconnecting in ${delay}ms`);
      this.setStatus('down', `${why}${next}; reconnecting`);
      this.timeout(delay, async () => {
        // In JWT mode, fetch a new token only after a refusal or if the scheduled renewal failed; a
        // reconnect after a network blip reuses the current one (DK's client also serves a cached token).
        if (this.tokenMode === 'anonymous-jwt' && (refused || Date.now() >= this.jwtRenewAt)) await this.renewJwt();
        this.connect();
      });
    });
  }

  /**
   * DK refused our subscription. In default-token mode, two refusals in a row switch the socket to
   * DK's anonymous JWT for good; in JWT mode, a fresh token is fetched before the reconnect. DK's own
   * client does the same on a subscription error (`refreshTokenAndReInit`).
   */
  private onTokenRejected(reason: string): void {
    this.tokenRejections++;
    if (this.tokenMode === 'default' && this.tokenRejections >= TOKEN_REJECTIONS_BEFORE_JWT) {
      this.tokenMode = 'anonymous-jwt';
      this.log(`${reason}; switching the socket to DK's anonymous JWT`);
    } else {
      this.log(`${reason} (${this.tokenRejections} in a row)`);
    }
  }

  /**
   * Fetch DK's anonymous JWT and schedule its renewal at 90% of its lifetime, with 3 tries 2 s apart:
   * DK's own token manager uses the same schedule (`getTokenRenewTimeout`: `1e3*(e-10*e/100)`).
   */
  private renewJwt(): Promise<void> {
    this.jwtFetch ??= (async () => {
      for (let attempt = 1; attempt <= JWT_FETCH_ATTEMPTS && this.running; attempt++) {
        try {
          const res = await requestJson<{ token?: string; expiresIn?: number }>(this.tokenUrl, {
            dispatcher: this.http,
            timeoutMs: SNAPSHOT_TIMEOUT_MS,
            headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://sportsbook.draftkings.com', Referer: 'https://sportsbook.draftkings.com/' },
          });
          if (!res.data.token) throw new Error('no token in response');
          const renewed = this.jwt !== DEFAULT_TOKEN;
          this.jwt = res.data.token;
          const lifetimeMs = Math.max(10, res.data.expiresIn ?? 120) * 1_000;
          this.jwtRenewAt = Date.now() + lifetimeMs * JWT_RENEW_AT;
          clearTimeout(this.jwtTimer);
          // Like DK's client, a renewed token is kept for the next subscribe or connection; the live subscription is left alone.
          this.jwtTimer = this.timeout(lifetimeMs * JWT_RENEW_AT, () => this.renewJwt());
          this.log(`${renewed ? 'renewed' : 'fetched'} DK anonymous JWT (expires in ${Math.round(lifetimeMs / 1000)}s)`);
          return;
        } catch (err) {
          this.log(`anonymous JWT fetch failed (attempt ${attempt}/${JWT_FETCH_ATTEMPTS}): ${errMsg(err)}`);
          if (attempt < JWT_FETCH_ATTEMPTS) await sleep(JWT_RETRY_MS);
        }
      }
    })().finally(() => {
      this.jwtFetch = null;
    });
    return this.jwtFetch;
  }

  /** Subscribe before unsubscribing the previous query, so a query change never leaves a gap. */
  private subscribe(ws: WebSocket, partial: DkSubscriptionPartial): void {
    const previous = this.subscription;
    const id = randomUUID();
    this.subscription = { id, partial };
    this.subscribedAt = Date.now();
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        id,
        params: {
          entity: partial.entity ?? 'events',
          queryParams: { query: partial.query, includeMarkets: partial.includeMarkets, initialData: false, projection: 'sportsbook', locale: 'en' },
          forwardedHeaders: {},
          clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': CLIENT_VERSION },
          jwt: this.jwt,
          siteName: this.siteName,
        },
      }),
    );
    if (previous) ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'unsubscribe', params: {}, id: previous.id }));
  }

  private defaultPartial(): DkSubscriptionPartial {
    return {
      entity: 'events',
      query: `$filter=leagueId eq '${this.leagueId}' and clientMetadata/Subcategories/any(s: s/Id eq '${this.subcategoryId}')&$orderBy=startEventDate asc`,
      includeMarkets: `$filter=tags/all(t: t ne 'SportcastBetBuilder') and clientMetadata/subCategoryId eq '${this.subcategoryId}'`,
    };
  }

  /**
   * Subscribe-then-snapshot: frames that arrive before the snapshot is applied are buffered and
   * replayed on top of it, so nothing that moves during startup is lost. If REST is unavailable
   * after a reconnect, the last board keeps updating from live deltas, flagged degraded, while the
   * snapshot keeps retrying; a cold start has nothing to stand in and waits.
   */
  private async bootstrap(ws: WebSocket, epoch: number, first: Promise<JsonResponse<DkSnapshot>>): Promise<void> {
    this.bootstrapping = true;
    let pending = first;
    try {
      for (let attempt = 1; this.running && this.epoch === epoch; attempt++) {
        try {
          const snap = await pending;
          if (this.epoch !== epoch) return;
          // If we already went live on this connection without a snapshot, frames applied since are fresher.
          this.applySnapshot(snap.data, snap.sentAt, this.ready ? snap.sentAt - RECONCILE_TRUST_WINDOW_MS : 0);
          const replayed = this.goLive();
          this.restFailures = 0;
          this.tokenRejections = 0;
          this.wsAttempt = this.wsAttempt > 1 ? this.wsAttempt : 0;
          const since = (t: number) => (t ? `${t - this.connectStartedAt} ms` : 'n/a');
          this.log(
            `live in ${Date.now() - this.connectStartedAt} ms (subscribed ${since(this.ackAt)}, snapshot ${since(this.snapshotAt)}): ` +
              `${this.emittedGames.size} games, ${this.markets.size} markets, replayed ${replayed} buffered frames`,
          );
          this.setStatus('live');
          this.timeout(RESYNC_AFTER_BOOTSTRAP_MS, () => this.reconcile());
          // Follow the server's own subscription query if it ever differs from our default.
          const partial = Object.values(snap.data.subscriptionPartials ?? {}).find((p) => p.entity === 'events' && p.query);
          if (partial && partial.query !== this.subscription?.partial.query) {
            this.log(`switching to server subscription query: ${partial.query}`);
            this.subscribe(ws, partial);
          }
          return;
        } catch (err) {
          if (this.epoch !== epoch) return;
          this.restFailures++;
          this.log(`snapshot failed (attempt ${attempt}): ${errMsg(err)}`);
          if (!this.ready && this.events.size > 0 && Date.now() - this.lastReadyAt < MAX_DEGRADED_GAP_MS) {
            this.goLive();
            this.setStatus('degraded', `snapshot unavailable (${errMsg(err)}); live deltas over the last known board`);
          } else if (!this.ready) {
            this.setStatus('down', `snapshot unavailable: ${errMsg(err)}`);
          }
          // A failed snapshot is one cheap GET to retry; cap ordinary retries at 10 s so the book comes
          // back to fully live quickly, and back off hard only when DK is actively refusing us.
          await sleep(
            isBlocked(err)
              ? Math.max(err.retryAfterMs ?? 0, backoffMs(attempt, BLOCKED_BASE_MS, BLOCKED_MAX_MS))
              : backoffMs(attempt, 1_000, SNAPSHOT_RETRY_MAX_MS),
          );
          pending = this.fetchSnapshot();
        }
      }
    } finally {
      if (this.epoch === epoch) this.bootstrapping = false;
    }
  }

  /** Start applying frames directly, replaying any that arrived while the snapshot was pending. */
  private goLive(): number {
    if (this.ready) return 0;
    const backlog = this.buffered;
    this.buffered = [];
    this.ready = true;
    for (const { frame, rx } of backlog) this.applyFrame(frame, rx);
    return backlog.length;
  }

  private async fetchSnapshot(): Promise<JsonResponse<DkSnapshot>> {
    const res = await requestJson<Partial<DkSnapshot>>(this.restUrl, {
      dispatcher: this.http,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: 'https://sportsbook.draftkings.com',
        Referer: 'https://sportsbook.draftkings.com/',
      },
    });
    const d = res.data;
    // A body without the three entity lists is an error page or a partial read, never a real empty board.
    if (!d || !Array.isArray(d.events) || !Array.isArray(d.markets) || !Array.isArray(d.selections)) {
      throw new Error('malformed snapshot (missing events/markets/selections)');
    }
    return res as JsonResponse<DkSnapshot>;
  }

  /** Periodic full re-read. Anything a frame touched recently is fresher than the snapshot and is kept. */
  private async reconcile(): Promise<void> {
    if (!this.ready || this.reconciling || this.bootstrapping) return;
    const epoch = this.epoch;
    this.reconciling = true;
    try {
      const snap = await this.fetchSnapshot();
      // A reconnect while this was in flight hands the state to that connection's bootstrap, and an
      // older read must never overwrite a newer one.
      if (this.epoch !== epoch || !this.ready || snap.sentAt < this.lastSnapshotSentAt) return;
      const change = this.applySnapshot(snap.data, snap.sentAt, snap.sentAt - RECONCILE_TRUST_WINDOW_MS);
      if (change.quotes.length || change.removedQuotes.length) {
        this.log(`reconcile corrected ${change.quotes.length} quotes and ${change.removedQuotes.length} removals the socket had not delivered`);
        // Several corrections mean the socket missed frames, not just one: refresh the subscription too.
        if (change.quotes.length >= RECONCILE_DRIFT_RESUBSCRIBE) this.resubscribe(`reconcile corrected ${change.quotes.length} quotes`);
      }
      this.restFailures = 0;
      if (this.status.state === 'degraded') this.setStatus('live');
    } catch (err) {
      if (this.epoch !== epoch) return;
      this.restFailures++;
      this.log(`reconcile failed (${this.restFailures}x): ${errMsg(err)}`);
      // The socket still delivers changes; only drift protection is lost.
      if (this.restFailures >= 2 && this.status.state === 'live') {
        this.setStatus('degraded', isBlocked(err) ? `REST blocked (HTTP ${err.status}); socket deltas only` : 'REST reconcile failing; socket deltas only');
      }
    } finally {
      this.reconciling = false;
    }
  }

  // ---------------------------------------------------------------- state

  /**
   * Replace state with a REST snapshot. With `keepAfter = 0` (bootstrap) the snapshot wins
   * everywhere; otherwise entities a frame touched (or removed) after `keepAfter` are left alone.
   * Snapshot entities replace, never merge: REST omits `isSuspended` when false, so merging would
   * keep a stale suspension alive.
   */
  private applySnapshot(snap: DkSnapshot, sentAt: number, keepAfter: number): BookChange {
    const batch = newBatch();
    const fresher = (rx: number) => keepAfter > 0 && rx > keepAfter;
    const removedSince = (id: string) => keepAfter > 0 && (this.tombstones.get(id) ?? 0) > keepAfter;
    const ids = {
      events: new Set(snap.events.map((e) => e.id)),
      markets: new Set<string>(),
      selections: new Set(snap.selections.map((s) => s.id)),
    };

    // Games end one at a time (and DK removes them over the socket), so a snapshot that would drop
    // most of the board at once is far likelier a bad read than real; it must persist to count.
    const heldEvents = this.events.size;
    const eventDrops = [...this.events].filter(([id, cur]) => !ids.events.has(id) && !fresher(cur.rx)).length;
    const massDrop = heldEvents >= 4 && eventDrops > heldEvents * MASS_DROP_FRACTION;
    if (!massDrop) this.massDropSince = null;
    else this.massDropSince ??= sentAt;
    const holdDrops = massDrop && sentAt - this.massDropSince! < MASS_DROP_CONFIRM_MS;
    if (holdDrops) this.log(`snapshot would drop ${eventDrops} of ${heldEvents} games at once; holding them until a read ${MASS_DROP_CONFIRM_MS / 1000}s later agrees`);
    else if (massDrop) this.log(`mass drop confirmed across ${Math.round((sentAt - this.massDropSince!) / 1000)}s; applying`);

    for (const e of snap.events) {
      const cur = this.events.get(e.id);
      if (cur ? !fresher(cur.rx) : !removedSince(e.id)) this.putEvent(e, 0, batch);
    }
    for (const m of snap.markets) {
      if (marketTypeOf(m) === null) continue;
      ids.markets.add(m.id);
      const cur = this.markets.get(m.id);
      if (cur ? !fresher(cur.rx) : !removedSince(m.id)) this.putMarket(m, 0, batch);
    }
    for (const s of snap.selections) {
      const cur = this.selections.get(s.id);
      if (cur ? !fresher(cur.rx) : !removedSince(s.id)) this.putSelection(s, 0, batch);
    }

    if (!holdDrops) {
      for (const [id, cur] of this.selections) if (!ids.selections.has(id) && !fresher(cur.rx)) this.dropSelection(id, batch);
      for (const [id, cur] of this.markets) if (!ids.markets.has(id) && !fresher(cur.rx)) this.dropMarket(id, batch);
      for (const [id, cur] of this.events) if (!ids.events.has(id) && !fresher(cur.rx)) this.dropEvent(id, batch);
    }
    this.lastSnapshotSentAt = Math.max(this.lastSnapshotSentAt, sentAt);
    return this.flush(batch, 'snapshot', Date.now(), NO_TIMES);
  }

  private applyFrame(frame: DkFrame, rx: number): void {
    if (typeof frame.data !== 'object' || !frame.data?.data) return;
    const { add, change, remove } = frame.data.data;
    const times: FrameTimes = {
      createdAt: parseTime(frame.data.metadata?.createdTime),
      publishedAt: parseTime(frame.data.metadata?.publishedTime),
      gatewayAt: parseTime(frame.websocketPublishTimestamp),
    };
    const t = times.createdAt;
    const batch = newBatch();

    for (const e of add?.events ?? []) this.putEvent(e, rx, batch);
    for (const m of add?.markets ?? []) if (marketTypeOf(m) !== null) this.putMarket(m, rx, batch);
    for (const s of add?.selections ?? []) {
      const orphan = this.orphans.get(s.id);
      this.orphans.delete(s.id);
      this.putSelection(orphan && (orphan.t ?? 0) >= (t ?? 0) ? { ...s, ...definedFields(orphan.patch) } : s, rx, batch);
    }

    for (const patch of change?.events ?? []) {
      const cur = this.events.get(patch.id);
      if (cur) this.putEvent({ ...cur.v, ...definedFields(patch) }, rx, batch);
    }
    for (const patch of change?.markets ?? []) {
      const cur = this.markets.get(patch.id);
      if (cur) this.putMarket({ ...cur.v, ...definedFields(patch) }, rx, batch);
    }
    for (const patch of change?.selections ?? []) {
      const cur = this.selections.get(patch.id);
      // A change can arrive ahead of its selection's `add` during a line move; hold it briefly.
      if (cur) this.putSelection({ ...cur.v, ...definedFields(patch) }, rx, batch);
      else this.orphans.set(patch.id, { patch, rx, t });
    }

    for (const id of remove?.selections ?? []) this.dropSelection(id, batch, rx);
    for (const id of remove?.markets ?? []) this.dropMarket(id, batch, rx);
    for (const id of remove?.events ?? []) this.dropEvent(id, batch, rx);

    this.flush(batch, 'push', rx, times);
  }

  private putEvent(e: DkEvent, rx: number, batch: Batch): void {
    this.events.set(e.id, { v: e, rx, seq: this.events.get(e.id)?.seq ?? ++this.seq });
    batch.events.add(e.id);
    for (const m of this.marketsByEvent.get(e.id) ?? []) batch.markets.add(m);
  }

  private putMarket(m: DkMarket, rx: number, batch: Batch): void {
    const prev = this.markets.get(m.id);
    if (prev?.v.eventId && prev.v.eventId !== m.eventId) this.marketsByEvent.get(prev.v.eventId)?.delete(m.id);
    this.markets.set(m.id, { v: m, rx, seq: prev?.seq ?? ++this.seq });
    if (m.eventId) index(this.marketsByEvent, m.eventId, m.id);
    batch.markets.add(m.id);
  }

  private putSelection(s: DkSelection, rx: number, batch: Batch): void {
    const prev = this.selections.get(s.id);
    if (prev?.v.marketId && prev.v.marketId !== s.marketId) this.selectionsByMarket.get(prev.v.marketId)?.delete(s.id);
    this.selections.set(s.id, { v: s, rx, seq: prev?.seq ?? ++this.seq });
    if (s.marketId) {
      index(this.selectionsByMarket, s.marketId, s.id);
      batch.markets.add(s.marketId);
    }
  }

  private dropSelection(id: string, batch: Batch, rx?: number): void {
    if (rx !== undefined) this.tombstones.set(id, rx);
    const cur = this.selections.get(id);
    if (!cur) return;
    this.selections.delete(id);
    if (cur.v.marketId) {
      this.selectionsByMarket.get(cur.v.marketId)?.delete(id);
      batch.markets.add(cur.v.marketId);
    }
  }

  private dropMarket(id: string, batch: Batch, rx?: number): void {
    if (rx !== undefined) this.tombstones.set(id, rx);
    const cur = this.markets.get(id);
    if (!cur) return;
    // Refs need the event, so compute them before anything else goes.
    batch.removedQuotes.push(...this.refsForMarket(cur.v));
    batch.markets.delete(id);
    this.markets.delete(id);
    if (cur.v.eventId) this.marketsByEvent.get(cur.v.eventId)?.delete(id);
    for (const sid of this.selectionsByMarket.get(id) ?? []) this.selections.delete(sid);
    this.selectionsByMarket.delete(id);
  }

  private dropEvent(id: string, batch: Batch, rx?: number): void {
    if (rx !== undefined) this.tombstones.set(id, rx);
    for (const m of [...(this.marketsByEvent.get(id) ?? [])]) this.dropMarket(m, batch, rx);
    this.marketsByEvent.delete(id);
    if (this.events.delete(id)) batch.events.add(id);
  }

  // ---------------------------------------------------------------- normalization

  /** Turn a batch of touched entities into normalized games/quotes and commit them as one change. */
  private flush(batch: Batch, channel: Channel, receivedAt: number, times: FrameTimes): BookChange {
    const games: BookGame[] = [];
    const removedGames: string[] = [];
    for (const m of batch.markets) {
      const eventId = this.markets.get(m)?.v.eventId;
      if (eventId) batch.events.add(eventId);
    }
    for (const eventId of batch.events) {
      const ev = this.events.get(eventId);
      const game = ev ? this.toGame(ev.v) : null;
      const prev = this.emittedGames.get(eventId);
      if (prev && prev.gameKey !== game?.gameKey) {
        removedGames.push(prev.gameKey);
        this.emittedGames.delete(eventId);
      }
      if (game) {
        this.emittedGames.set(eventId, game);
        games.push(game);
      }
    }

    const quotes: Quote[] = [];
    for (const marketId of batch.markets) {
      const m = this.markets.get(marketId);
      const type = m ? marketTypeOf(m.v) : null;
      const game = m?.v.eventId ? this.emittedGames.get(m.v.eventId) : undefined;
      if (!m || !type || !game) continue;
      const bySide = this.selectionsBySide(marketId);
      for (const side of MARKET_SIDES[type]) {
        const ref = { gameKey: game.gameKey, market: type, side };
        const s = bySide.get(side);
        const american = s ? (parseAmerican(s.v.displayOdds?.american) ?? (s.v.trueOdds !== undefined ? decimalToAmerican(s.v.trueOdds) : null)) : null;
        if (!s || american === null) {
          if (this.hasQuote(ref) && !this.pendingRemovals.has(quoteKey(ref))) this.pendingRemovals.set(quoteKey(ref), { ref, marketId, at: receivedAt });
          continue;
        }
        this.pendingRemovals.delete(quoteKey(ref));
        quotes.push({
          book: this.book,
          ...ref,
          line: type === 'moneyline' ? null : (s.v.points ?? null),
          american,
          decimal: s.v.trueOdds ?? americanToDecimal(american),
          suspended: Boolean(m.v.isSuspended),
          live: game.live,
          bookTime: times.createdAt,
          receivedAt,
          channel,
        });
      }
    }

    this.emitSamples(quotes, true, times);
    const emitted = new Set(quotes.map(quoteKey));
    return this.commit({ games, removedGames, quotes, removedQuotes: batch.removedQuotes.filter((r) => !emitted.has(quoteKey(r))) });
  }

  /** During a line move the old and new selection briefly coexist; prefer DK's main line, then the newest. */
  private selectionsBySide(marketId: string): Map<Side, Tracked<DkSelection>> {
    const bySide = new Map<Side, Tracked<DkSelection>>();
    for (const sid of this.selectionsByMarket.get(marketId) ?? []) {
      const s = this.selections.get(sid);
      const side = s && OUTCOME_SIDES[s.v.outcomeType ?? ''];
      if (!s || !side) continue;
      const cur = bySide.get(side);
      if (!cur || rank(s) > rank(cur) || (rank(s) === rank(cur) && s.seq > cur.seq)) bySide.set(side, s);
    }
    return bySide;
  }

  private toGame(ev: DkEvent): BookGame | null {
    if (ev.status && !KNOWN_EVENT_STATUSES.has(ev.status) && !this.unknownStatuses.has(ev.status)) {
      this.unknownStatuses.add(ev.status);
      this.log(`unknown event status "${ev.status}" (treated as not live)`);
    }
    // A finished game's prices are not offers any more; retire it rather than show it as live.
    if (ev.status === 'FINISHED') return null;
    const home = ev.participants?.find((p) => p.venueRole === 'Home');
    const away = ev.participants?.find((p) => p.venueRole === 'Away');
    const h = resolveTeam(home?.metadata?.rosettaTeamName) ?? resolveTeam(home?.name);
    const a = resolveTeam(away?.metadata?.rosettaTeamName) ?? resolveTeam(away?.name);
    if (!h || !a || !ev.startEventDate) {
      if (!this.unresolvedEvents.has(ev.id)) {
        this.unresolvedEvents.add(ev.id);
        this.log(`unmapped teams for event ${ev.id} "${ev.name ?? '?'}" (away "${away?.name ?? '?'}", home "${home?.name ?? '?'}")`);
      }
      return null;
    }
    return {
      book: this.book,
      gameKey: gameKey(a, h, ev.startEventDate),
      bookEventId: ev.id,
      away: a.code,
      home: h.code,
      startTime: new Date(ev.startEventDate).toISOString(),
      live: ev.status === 'STARTED',
    };
  }

  private refsForMarket(m: DkMarket): QuoteRef[] {
    const type = marketTypeOf(m);
    const game = m.eventId ? this.emittedGames.get(m.eventId) : undefined;
    return type && game ? MARKET_SIDES[type].map((side) => ({ gameKey: game.gameKey, market: type, side })) : [];
  }

  // ---------------------------------------------------------------- plumbing

  /** Replace the subscription without dropping the socket (make-before-break); rate-limited. */
  private resubscribe(reason: string): void {
    const ws = this.ws;
    const now = Date.now();
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.subscription || now - this.lastResubscribeAt < LIVE_SUBSCRIPTION_SILENCE_MS) return;
    this.lastResubscribeAt = this.lastUpdateFrameAt = now;
    this.log(`resubscribing: ${reason}`);
    this.subscribe(ws, this.subscription.partial);
  }

  private housekeeping(): void {
    const now = Date.now();
    if (this.ready && now - this.lastUpdateFrameAt > LIVE_SUBSCRIPTION_SILENCE_MS && [...this.emittedGames.values()].some((g) => g.live)) {
      this.resubscribe(`no update frames for ${Math.round((now - this.lastUpdateFrameAt) / 1000)}s while games are live`);
    }
    const expired: QuoteRef[] = [];
    for (const [key, p] of this.pendingRemovals) {
      if (now - p.at < REPLACEMENT_GRACE_MS) continue;
      this.pendingRemovals.delete(key);
      if (!this.selectionsBySide(p.marketId).has(p.ref.side)) expired.push(p.ref);
    }
    if (expired.length) this.commit({ removedQuotes: expired });
    for (const [id, o] of this.orphans) if (now - o.rx > ORPHAN_TTL_MS) this.orphans.delete(id);
    for (const [id, at] of this.tombstones) if (now - at > 2 * this.reconcileIntervalMs) this.tombstones.delete(id);
  }

  private timeout(ms: number, fn: () => void | Promise<void>): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) void fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private every(ms: number, fn: () => void | Promise<void>): void {
    this.timeout(ms, async () => {
      try {
        await fn();
      } catch (err) {
        this.log(`periodic task failed: ${errMsg(err)}`);
      } finally {
        this.every(ms, fn);
      }
    });
  }
}

/**
 * DK's own client waits at least 5 s after 4001 and 1013. It treats 4000 (insufficient params, e.g. the
 * jwt) as terminal; we handle it as a token refusal instead (onTokenRejected), so it has no floor here.
 */
function closeFloorMs(code: number): number {
  if (code === 4001 || code === 1013) return 5_000;
  return 0;
}

function marketTypeOf(m: DkMarket): MarketType | null {
  const name = (m.marketType?.name ?? m.name ?? '').toLowerCase();
  if (name === 'moneyline') return 'moneyline';
  if (name === 'spread' || name === 'point spread') return 'spread';
  if (name === 'total' || name === 'total points') return 'total';
  // betOfferTypeId as seen in DK payloads: 2 moneyline, 1 spread, 6 total.
  return ({ 2: 'moneyline', 1: 'spread', 6: 'total' } as Record<number, MarketType>)[m.marketType?.betOfferTypeId ?? -1] ?? null;
}

const NO_TIMES: FrameTimes = { createdAt: null, publishedAt: null, gatewayAt: null };

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

const rank = (s: Tracked<DkSelection>) => (s.v.main === true || s.v.tags?.includes('MainPointLine') ? 1 : 0);
const newBatch = (): Batch => ({ events: new Set(), markets: new Set(), removedQuotes: [] });

function index(map: Map<string, Set<string>>, key: string, id: string): void {
  const set = map.get(key) ?? new Set<string>();
  set.add(id);
  map.set(key, set);
}

function definedFields<T extends object>(patch: T): Partial<T> {
  return Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
