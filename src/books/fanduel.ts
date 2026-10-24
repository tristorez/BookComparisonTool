import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Dispatcher } from 'undici';
import { BROWSER_UA, HttpError, backoffMs, createDispatcher, createWsAgent, errMsg, isBlocked, requestJson, type JsonResponse } from './http.js';
import { parseAmerican } from './odds.js';
import { americanToDecimal } from '../shared/odds.js';
import { PROP_STATS, type PropGroup, type PropStat } from '../shared/props.js';
import { gameKey, resolveTeam, type Team } from './teams.js';
import { BookConnector, ouPrices, quoteRefsFor, type BookGame, type BookProp, type Channel, type MarketType, type Quote, type QuoteRef, type Side } from './types.js';

/**
 * FanDuel connector.
 *
 * FD runs on Flutter's Betfair-derived platform (the SMP origin answers as `Cougar`). Three public
 * endpoints, all read without cookies or login:
 *  - sbapi  `content-managed-page` / `in-play`: the board (events, markets, runners). CDN-cached
 *           for 30s + 60s stale-while-revalidate, so it is used for discovery only, never prices.
 *  - smp    `getMarketPrices` (POST): uncached origin read of current prices. FD's web board polls
 *           this every 5s; we poll every 1s, on a wall-clock phase so two feed hosts interleave.
 *  - pir    AWS AppSync GraphQL subscription `onUpdateMarketPrice`: FD's push-pricing channel,
 *           wired into the web bundle for the betslip and handed to the native apps. It pushes
 *           full market state per change with an `updatedAt` stamp (whole seconds).
 * Push and polling race; `MarketMerge` shows each market's new state from whichever channel has it
 * first, with push applied in book order.
 */

/**
 * FanDuel's public keys, as shipped in its web bundle on 2026-10-19. They are not secrets or sessions
 * and do not expire, but FD can rotate them with a deploy; if FD rejects one, `refreshKeys` re-reads the
 * live bundle and adopts whichever candidate the live API accepts (SMP polling needs no key meanwhile).
 */
const DEFAULT_APP_KEY = 'FhMFpcPWXMeyZxOx'; // `_ak` on sbapi calls
const DEFAULT_PIR_KEY = 'NfxZUKb5R+do8pGKXq27wPTO3JHUlUmn'; // AppSync client id for PIR (auth type PIR_AUTH_KEY)
const SITE = 'https://sportsbook.fanduel.com';
/** A key refresh downloads FD's main bundle (4.6 MB of JS, ~1.4 MB gzipped); at most one per this gap. */
const KEY_REFRESH_MIN_GAP_MS = 300_000;
/** ...unless the bundle couldn't be read at all (network, timeout), which may retry after this. */
const KEY_REFRESH_RETRY_MS = 30_000;
const AMERICAN_FOOTBALL = 6423; // Betfair eventTypeId
const TIMEZONE = encodeURIComponent('America/New_York');
const NFL_COMPETITION = 'NFL';

const GAME_LINE_TYPES: Record<string, MarketType> = {
  MONEY_LINE: 'moneyline',
  'MATCH_HANDICAP_(2-WAY)': 'spread',
  'TOTAL_POINTS_(OVER/UNDER)': 'total',
};
const RESULT_SIDES: Record<string, Side> = { HOME: 'home', AWAY: 'away', OVER: 'over', UNDER: 'under' };

/** The event-page tab holding each group of player props (the site's own tab slugs). */
const PROP_TABS: Record<PropGroup, string> = {
  passing: 'passing-props',
  rushing: 'rushing-props',
  receiving: 'receiving-props',
  touchdowns: 'td-scorer-props',
};
/**
 * Over/under player props are `PLAYER_X_<STAT>`, often with a `_HIGH`/`_MEDIUM`/`_LOW` tier, and OVER/UNDER
 * runners whose handicap is the line; `PLAYER_X_ALT_<STAT>` are milestone ladders and are left out. These
 * are the stats FD's NJ prop tabs listed for every game we read (2026-10-23).
 */
const FD_OU_STATS: Record<string, PropStat> = {
  PASSING_YARDS: 'pass_yds',
  PASSING_TOUCHDOWNS: 'pass_tds',
  RUSHING_YARDS: 'rush_yds',
  'RUSHING_+_RECEIVING_YARDS': 'rush_rec_yds',
  RECEIVING_YARDS: 'rec_yds',
  RECEPTIONS: 'receptions',
};
/** Scorer markets: one runner per player. */
const FD_YES_STATS: Record<string, PropStat> = {
  ANY_TIME_TOUCHDOWN_SCORER: 'td_anytime',
  X_TOUCHDOWN_SCORER_QB: 'td_first', // "1st Touchdown Scorer"
  LAST_TOUCHDOWN_SCORER: 'td_last',
  'TO_SCORE_2+_TOUCHDOWNS': 'td_2plus',
};
/**
 * A props tab's markets (players, lines) are re-read at most this often, as the board is: the event page
 * is CDN-cached anyway, and every props read prices the markets from SMP. Unused tabs are dropped after
 * PROP_PAGE_EVICT_MS.
 */
const PROP_PAGE_TTL_MS = 30_000;
const PROP_PAGE_EVICT_MS = 10 * 60_000;

// FD's own client batches 70 ids per SMP request and 350 per PIR subscription.
const POLL_BATCH = 70;
const SUBSCRIPTION_BATCH = 350;

/** A healthy SMP read takes 10–60 ms; a hung one must not stall the 1 s cadence. */
const POLL_TIMEOUT_MS = 2_000;
/** Board page reads (and key-refresh downloads); the board page is large and only needed every 30 s. */
const DISCOVERY_TIMEOUT_MS = 8_000;
/** First retry delay while the board is failing or empty; doubles up to the regular discovery interval. */
const DISCOVERY_RETRY_BASE_MS = 2_000;
/** On-demand rediscovery (a market vanished from SMP) is rate-limited to this gap. */
const DISCOVERY_MIN_GAP_MS = 5_000;
/** Drop a market only after this many consecutive board refreshes stop listing it. */
const MISSED_DISCOVERIES_BEFORE_DROP = 2;
/** SMP omits closed markets; this many consecutive omissions mean the market is gone. */
const MISSED_POLLS_BEFORE_CLOSED = 3;
/** The CDN-cached board keeps listing a closed market for up to ~90 s; don't re-adopt it meanwhile. */
const CLOSED_TOMBSTONE_MS = 120_000;
/** After start, a channel that hasn't connected or polled yet is reported as pending, not failing. */
const STARTUP_GRACE_MS = 10_000;

// Liveness: AppSync answers WebSocket pings ~1 s late (measured) and sends `ka` only every 60 s, so a
// ping every 5 s with a 12 s silence limit is the fastest dead-socket detection it supports.
const WATCHDOG_TICK_MS = 1_000;
const PING_EVERY_TICKS = 5;
const SILENCE_TIMEOUT_MS = 12_000;
// Reconnects: retry fast once, back off exponentially if the socket keeps failing, much harder when blocked.
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 30_000;
const STABLE_CONNECTION_MS = 30_000;
const BLOCKED_BASE_MS = 30_000;
const BLOCKED_MAX_MS = 600_000;
/** First retry after AppSync rejects or ends a subscription; backs off up to RECONNECT_MAX_MS. */
const SUBSCRIBE_RETRY_BASE_MS = 1_000;

/** PIR's subscription: each `data` message is one market's full price state (every runner). */
const PIR_SUBSCRIPTION = `subscription OnUpdateMarketPrice($ids: [String!]!) {
  onUpdateMarketPrice(ids: $ids) {
    marketId marketStatus inplay updatedAt
    runnerDetails { selectionId handicap runnerStatus winRunnerOdds { americanDisplayOdds { americanOddsInt } trueOdds { decimalOdds { decimalOdds } } } }
  }
}`;

interface FdOdds {
  americanDisplayOdds?: { americanOdds?: number; americanOddsInt?: number };
  trueOdds?: { decimalOdds?: { decimalOdds?: number } };
}
interface FdRunner {
  selectionId: number;
  runnerName?: string;
  handicap?: number;
  runnerStatus?: string;
  result?: { type?: string };
  winRunnerOdds?: FdOdds;
  /** Event pages: the player's team jersey, e.g. `…/images/team/nfl/kansas_city_chiefs_jersey.png`. */
  logo?: string;
  isPlayerSelection?: boolean;
}
interface FdMarket {
  marketId: string;
  eventId: number;
  competitionId?: number;
  marketType: string;
  /** Event pages: e.g. "Patrick Mahomes - Passing Yds". */
  marketName?: string;
  marketStatus?: string;
  runners?: FdRunner[];
}
interface FdEvent {
  eventId: number;
  name: string;
  openDate: string;
  eventTypeId?: number;
  competitionId?: number;
}
interface FdPage {
  attachments?: {
    events?: Record<string, FdEvent>;
    markets?: Record<string, FdMarket>;
    competitions?: Record<string, { name?: string }>;
  };
}
/** Shape shared by SMP `getMarketPrices` items and PIR `onUpdateMarketPrice` payloads. */
interface FdPriceUpdate {
  marketId: string;
  marketStatus?: string;
  inplay?: boolean;
  updatedAt?: string;
  runnerDetails?: FdRunner[];
}

/**
 * Merges FanDuel's two views of one market so a price is shown as soon as either channel has it.
 * PIR push is complete and ordered but late; SMP polls are sampled each second and, when they differ
 * from push, are almost always ahead (measured on a live recording: 288 of 297 differing poll
 * observations were states push delivered later, by p50 235 ms; none were stale reads).
 *  1. Push frames apply in `updatedAt` order (a frame older than one already applied is dropped).
 *  2. Otherwise, whichever channel shows a different state first wins.
 * Two extra guards were tried and removed on the evidence (scripts/replay-merge.ts): blocking
 * "recently superseded" states delayed 35 of 312 poll-led states (prices oscillate and the poll often
 * sees the reversal first); holding push frames while a poll led delayed 10 states by ~0.6 s (the poll
 * had shown a transient state push never sends). Neither prevented a single wrong-way flip.
 */
export class MarketMerge {
  /** Signature (`signatureOf`) of the state on screen; '' forces the next observation to be shown. */
  shown = '';
  private lastPushBookTime = 0;

  /** Offer one observed market state; returns true if it should be shown. */
  offer(channel: Channel, sig: string, bookTime: number | null): boolean {
    if (channel === 'push' && bookTime !== null) {
      if (bookTime < this.lastPushBookTime) return false; // out of order
      this.lastPushBookTime = bookTime;
    }
    if (sig === this.shown) return false;
    this.shown = sig;
    return true;
  }
}

/** One main-line market we price, by FD market id. */
interface TrackedMarket {
  marketId: string;
  eventId: string;
  gameKey: string;
  type: MarketType;
  /** FD runner (selection) id → our side, from the board's runner `result.type`. */
  sides: Map<number, Side>;
  inPlay: boolean;
  /** Push/poll race state for this market (see MarketMerge). */
  merge: MarketMerge;
  /** Consecutive board refreshes that did not list it (dropped at MISSED_DISCOVERIES_BEFORE_DROP). */
  missedDiscoveries: number;
  /** Consecutive SMP answers that left it out (closed at MISSED_POLLS_BEFORE_CLOSED). */
  missedPolls: number;
  /** Logged an unknown runner once already (FD added a selection the board refresh hasn't shown us). */
  warnedUnknownRunner: boolean;
}

export interface FanDuelOptions {
  /** FD state subdomain for sbapi/smp/pir. Each state has its own market-id namespace (nj = 734.x, mo = 729.x). */
  region?: string;
  /** Subscribe to the PIR push channel. */
  push?: boolean;
  /** SMP poll cadence in ms (FD's own board uses 5000); 0 disables polling. */
  pollIntervalMs?: number;
  /**
   * Wall-clock phase of the poll schedule: polls fire at `phase + k × interval`. Two feed hosts
   * with phases 0 and interval/2 interleave, halving the effective interval with no extra load per IP.
   */
  pollPhaseMs?: number;
  /** Board refresh cadence for new or removed games and markets. Matches the board's 30s CDN TTL. */
  discoveryIntervalMs?: number;
  proxyUrl?: string;
  /** Starting keys (default: the ones in FD's bundle today). If FD rejects them, fresh ones are read from its live bundle. */
  appKey?: string;
  pirKey?: string;
}

export class FanDuelConnector extends BookConnector {
  readonly book = 'fanduel' as const;

  private readonly region: string;
  private readonly push: boolean;
  private readonly pollIntervalMs: number;
  private readonly pollPhaseMs: number;
  private readonly discoveryIntervalMs: number;
  private readonly proxyUrl: string | undefined;
  private readonly http: Dispatcher;
  /** Player props' own connection pool, so slow props reads can't queue the 1 s poll or discovery. */
  private readonly propsHttp: Dispatcher;
  private appKey: string;
  private pirKey: string;
  private keyRefresh: Promise<boolean> | null = null;
  private lastKeyRefreshAt = 0;
  /** Set while FD is rejecting a key we hold; cleared once a request with it succeeds. */
  private keyProblem: string | null = null;

  private readonly markets = new Map<string, TrackedMarket>();
  private readonly events = new Map<string, BookGame>(); // by FD eventId
  private readonly closedMarkets = new Map<string, number>(); // marketId -> closed at
  /** Each props group's markets by `<eventId>|<group>`, and when its tab was read (PROP_PAGE_TTL_MS). */
  private readonly propPages = new Map<string, { markets: FdMarket[]; at: number }>();
  /** Groups whose tab listed player props of no type we read: logged once. */
  private readonly warnedPropTypes = new Set<PropGroup>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private running = false;
  /**
   * Incremented by every `start()`. A loop whose step was in flight across a stop/start (the board's
   * frozen-feed restart, the chaos routes) sees a newer run and stops re-arming, so the restart can't
   * leave two poll loops behind.
   */
  private runId = 0;
  private startedAt = 0;

  /** Consecutive failed board refreshes: drives the retry backoff, and 3+ is reported. */
  private discoveryFailures = 0;
  private discoveryInFlight: Promise<void> | null = null;
  private discoveryTimer: NodeJS.Timeout | undefined;
  private lastDiscoveryAt = 0;
  private lastCompetitionWarningAt = 0;

  /** Consecutive failed SMP polls (backoff); `pollBlocked` says why when FD is refusing us. */
  private pollFailures = 0;
  private pollBlocked: string | null = null;
  private lastPollOkAt = 0;

  private ws: WebSocket | null = null;
  /** Incremented per push connection; handlers of an older socket become no-ops. */
  private pushEpoch = 0;
  /** AppSync acknowledged `connection_init`: subscriptions may be started. */
  private wsAcked = false;
  /** Consecutive failed connections, for the reconnect backoff; reset once a connection proves stable. */
  private wsAttempt = 0;
  /** Last message or pong on the push socket, for the silence watchdog and push health. */
  private wsLastSeenAt = 0;
  private pushBlocked: string | null = null;
  /** Acknowledged subscriptions currently delivering prices, and the market set they cover. */
  private liveSubs: string[] = [];
  private liveSignature = '';
  /** A replacement subscription set, started but not yet fully acknowledged. */
  private nextSubs: { ids: string[]; acked: Set<string>; signature: string } | null = null;
  /** Consecutive subscription failures, for the resubscribe backoff; reset when a set is promoted. */
  private subscribeAttempt = 0;

  constructor(opts: FanDuelOptions = {}) {
    super();
    this.region = (opts.region ?? 'nj').toLowerCase();
    this.push = opts.push ?? true;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.pollPhaseMs = opts.pollPhaseMs ?? 0;
    this.discoveryIntervalMs = opts.discoveryIntervalMs ?? 30_000;
    this.proxyUrl = opts.proxyUrl;
    this.http = createDispatcher(opts.proxyUrl);
    this.propsHttp = createDispatcher(opts.proxyUrl);
    this.appKey = opts.appKey ?? DEFAULT_APP_KEY;
    this.pirKey = opts.pirKey ?? DEFAULT_PIR_KEY;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.runId++;
    this.startedAt = Date.now();
    this.setStatus('connecting');
    // The socket handshake overlaps the first board read; subscriptions start as soon as markets are known.
    if (this.push) this.connectPush();
    await this.runDiscovery();
    if (this.pollIntervalMs > 0) this.schedulePoll(0);
    this.every(1_000, () => this.housekeeping());
    this.evaluateHealth();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pushEpoch++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.ws?.close(1000);
    this.ws = null;
    this.wsAcked = false;
    this.setStatus('stopped');
  }

  // ---------------------------------------------------------------- discovery

  /** Run one board refresh (or join the one in flight) and schedule the next. */
  private async runDiscovery(): Promise<void> {
    if (this.discoveryInFlight) return this.discoveryInFlight;
    this.lastDiscoveryAt = Date.now();
    this.discoveryInFlight = this.discover().finally(() => {
      this.discoveryInFlight = null;
    });
    await this.discoveryInFlight;
    if (!this.running) return;
    // Fast retries while the board is failing or empty; the regular cadence once it is healthy.
    const next =
      this.discoveryFailures || !this.markets.size
        ? backoffMs(Math.max(1, this.discoveryFailures), DISCOVERY_RETRY_BASE_MS, this.discoveryIntervalMs)
        : this.discoveryIntervalMs;
    clearTimeout(this.discoveryTimer);
    this.discoveryTimer = this.timeout(next, () => this.runDiscovery());
  }

  /** Refresh the board out of cycle, e.g. when SMP stops returning a market; rate-limited. */
  private requestDiscovery(reason: string): void {
    if (this.discoveryInFlight || Date.now() - this.lastDiscoveryAt < DISCOVERY_MIN_GAP_MS) return;
    this.log(`refreshing board: ${reason}`);
    void this.runDiscovery();
  }

  private async discover(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const [board, inPlay] = await Promise.all([
          this.getJson<FdPage>(`${this.sbapi}/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&timezone=${TIMEZONE}&_ak=${this.appKey}`, {
            timeoutMs: DISCOVERY_TIMEOUT_MS,
          }).then((r) => r.data),
          // Live games are also on the NFL page; the in-play feed is a second source in case they drop off it.
          this.getJson<FdPage>(`${this.sbapi}/in-play?eventTypeId=${AMERICAN_FOOTBALL}&includeTabs=false&timezone=${TIMEZONE}&_ak=${this.appKey}`, {
            timeoutMs: DISCOVERY_TIMEOUT_MS,
          })
            .then((r) => r.data)
            .catch((err: unknown) => (this.log(`in-play fetch failed: ${errMsg(err)}`), null)),
        ]);
        if (this.keyProblem?.startsWith('app key')) this.keyProblem = null;
        await this.reconcileBoard([board, inPlay].filter((p): p is FdPage => p !== null), board);
        this.discoveryFailures = 0;
      } catch (err) {
        // A rotated app key answers `{"error":true}` (see isKeyRejection); fetch the current one and retry at once.
        if (isKeyRejection(err)) {
          this.keyProblem = `app key rejected (HTTP ${err.status})`;
          if (attempt === 1 && (await this.refreshKeys(`FanDuel rejected the app key (HTTP ${err.status})`))) continue;
        }
        this.discoveryFailures++;
        this.log(`board discovery failed (${this.discoveryFailures}x): ${errMsg(err)}`);
      }
      break;
    }
    this.evaluateHealth();
  }

  /**
   * FanDuel rejected a key: re-read its live web bundle for the current ones and adopt whichever
   * candidate the live API accepts. Rate-limited; resolves true if a key changed.
   */
  private refreshKeys(reason: string): Promise<boolean> {
    if (this.keyRefresh) return this.keyRefresh;
    if (Date.now() - this.lastKeyRefreshAt < KEY_REFRESH_MIN_GAP_MS) return Promise.resolve(false);
    this.lastKeyRefreshAt = Date.now();
    this.log(`${reason}; re-reading FanDuel's web bundle for its current keys`);
    this.keyRefresh = (async () => {
      try {
        const found = await readKeysFromBundle((url) => this.getText(url));
        const changes: string[] = [];
        for (const candidate of found.appKeys) {
          if (candidate === this.appKey || !(await this.appKeyWorks(candidate))) continue;
          this.appKey = candidate;
          changes.push('app key');
          break;
        }
        if (found.pirKey && found.pirKey !== this.pirKey && (await this.pirKeyWorks(found.pirKey))) {
          this.pirKey = found.pirKey;
          changes.push('push key');
          // Reconnect push with the new key (a socket still authenticated with the old one would keep failing).
          if (this.push) {
            this.ws?.terminate();
            this.timeout(0, () => this.connectPush());
          }
        }
        this.log(changes.length ? `adopted FanDuel's current ${changes.join(' and ')} from its bundle` : 'bundle keys match ours or none validated');
        if (changes.length) this.keyProblem = null;
        return changes.length > 0;
      } catch (err) {
        this.lastKeyRefreshAt = Date.now() - KEY_REFRESH_MIN_GAP_MS + KEY_REFRESH_RETRY_MS;
        this.log(`key refresh failed: ${errMsg(err)}`);
        return false;
      } finally {
        this.keyRefresh = null;
        this.evaluateHealth();
      }
    })();
    return this.keyRefresh;
  }

  private async appKeyWorks(key: string): Promise<boolean> {
    try {
      const url = `${this.sbapi}/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&_ak=${key}`;
      return Boolean((await this.getJson<FdPage>(url, { timeoutMs: DISCOVERY_TIMEOUT_MS })).data.attachments);
    } catch {
      return false;
    }
  }

  /** A rejected key answers 401 UnauthorizedException; any other answer (even a resolver error) means AppSync accepted it. */
  private async pirKeyWorks(key: string): Promise<boolean> {
    try {
      const res = await requestJson<{ errors?: unknown }>(`https://pir.${this.region}.sportsbook.fanduel.com/graphql`, {
        dispatcher: this.http,
        method: 'POST',
        timeoutMs: DISCOVERY_TIMEOUT_MS,
        headers: { 'User-Agent': BROWSER_UA, 'Content-Type': 'application/json', Authorization: key },
        body: JSON.stringify({ query: 'query($ids:[String]!){getMarketPrices(ids:$ids){marketId}}', variables: { ids: [...this.markets.keys()].slice(0, 1) } }),
      });
      return !isUnauthorized(res.data.errors);
    } catch {
      return false;
    }
  }

  private async reconcileBoard(pages: FdPage[], board: FdPage): Promise<void> {
    const seen = new Set<string>();
    const fresh: string[] = [];
    const rekeyed: string[] = [];
    const games: BookGame[] = [];
    const now = Date.now();

    for (const page of pages) {
      // A board without attachments is an error page; counting it as "nothing listed" would retire every market.
      if (!page.attachments) throw new Error('board response has no attachments');
      const att = page.attachments;
      const nflCompetitions = new Set(
        Object.entries(att.competitions ?? {})
          .filter(([, c]) => c.name === NFL_COMPETITION)
          .map(([id]) => Number(id)),
      );
      // The NFL page normally carries an 'NFL' competition; if it vanishes, the filter below would silently hide every game.
      if (page === board && !nflCompetitions.size && Object.keys(att.events ?? {}).length && now - this.lastCompetitionWarningAt > 600_000) {
        this.lastCompetitionWarningAt = now;
        this.log(`NFL page lists events but no '${NFL_COMPETITION}' competition (have: ${Object.values(att.competitions ?? {}).map((c) => c.name).join(', ')})`);
      }
      const marketsByEvent = new Map<number, FdMarket[]>();
      for (const m of Object.values(att.markets ?? {})) {
        if (!GAME_LINE_TYPES[m.marketType]) continue;
        const list = marketsByEvent.get(m.eventId) ?? [];
        list.push(m);
        marketsByEvent.set(m.eventId, list);
      }

      for (const ev of Object.values(att.events ?? {})) {
        const markets = marketsByEvent.get(ev.eventId);
        if (!markets || ev.competitionId === undefined || !nflCompetitions.has(ev.competitionId)) continue;
        const teams = teamsOf(ev, markets);
        if (!teams) {
          this.log(`unmapped teams for event ${ev.eventId} "${ev.name}"`);
          continue;
        }
        const eventId = String(ev.eventId);
        const key = gameKey(teams.away, teams.home, ev.openDate);
        const prev = this.events.get(eventId);
        if (prev && prev.gameKey !== key) {
          // Rescheduled onto another date: retire the old identity and re-price under the new one.
          rekeyed.push(prev.gameKey);
          for (const m of this.markets.values()) {
            if (m.eventId !== eventId) continue;
            m.gameKey = key;
            // The new key starts with no quotes, so the next observation must be shown even though the
            // prices themselves have not moved (MarketMerge would otherwise drop it as already shown).
            m.merge.shown = '';
            fresh.push(m.marketId);
          }
        }
        const game: BookGame = {
          book: this.book,
          gameKey: key,
          bookEventId: eventId,
          away: teams.away.code,
          home: teams.home.code,
          startTime: new Date(ev.openDate).toISOString(),
          live: prev?.live ?? false,
        };
        this.events.set(eventId, game);
        games.push(game);

        for (const m of markets) {
          if (this.closedMarkets.has(m.marketId)) continue;
          seen.add(m.marketId);
          const sides = sidesOf(m);
          const tracked = this.markets.get(m.marketId);
          if (tracked) {
            tracked.missedDiscoveries = 0;
            // Runner ids are stable in practice, but refresh them so a change can't silently drop a side.
            if (sides.size) tracked.sides = sides;
            continue;
          }
          this.markets.set(m.marketId, {
            marketId: m.marketId,
            eventId,
            gameKey: key,
            type: GAME_LINE_TYPES[m.marketType]!,
            sides,
            inPlay: false,
            merge: new MarketMerge(),
            missedDiscoveries: 0,
            missedPolls: 0,
            warnedUnknownRunner: false,
          });
          fresh.push(m.marketId);
        }
      }
    }

    // Retire markets the board no longer lists (game finished or pulled).
    const removedQuotes: QuoteRef[] = [];
    for (const m of this.markets.values()) {
      if (seen.has(m.marketId) || ++m.missedDiscoveries < MISSED_DISCOVERIES_BEFORE_DROP) continue;
      this.markets.delete(m.marketId);
      removedQuotes.push(...refsFor(m));
    }
    const removedGames = [...rekeyed, ...this.retireEmptyEvents()];
    this.commit({ games, removedQuotes, removedGames });

    if (fresh.length) {
      this.log(`tracking ${fresh.length} new markets (${this.markets.size} total)`);
      // Board prices are CDN-cached for up to 90s, so first prices come from the uncached SMP origin.
      await this.fetchPrices(fresh, 'snapshot').catch((err: unknown) => this.log(`initial price fetch failed: ${errMsg(err)}`));
    }
    this.syncSubscriptions();
  }

  /** Forget events that no longer have a tracked market; returns their game keys for `removedGames`. */
  private retireEmptyEvents(): string[] {
    const live = new Set<TrackedMarket['eventId']>();
    for (const m of this.markets.values()) live.add(m.eventId);
    const removed: string[] = [];
    for (const [eventId, g] of this.events) {
      if (live.has(eventId)) continue;
      this.events.delete(eventId);
      removed.push(g.gameKey);
    }
    return removed;
  }

  // ---------------------------------------------------------------- SMP polling

  /** One SMP poll of every tracked market after `delayMs`, then the next on the wall-clock grid (backing off on failure). */
  private schedulePoll(delayMs: number): void {
    const run = this.runId;
    this.timeout(delayMs, async () => {
      let delay: number;
      try {
        await this.fetchPrices([...this.markets.keys()], 'poll');
        this.pollFailures = 0;
        this.pollBlocked = null;
        delay = this.nextPollSlot();
      } catch (err) {
        this.pollFailures++;
        this.log(`SMP poll failed (${this.pollFailures}x): ${errMsg(err)}`);
        if (isBlocked(err)) {
          this.pollBlocked = `polling blocked (HTTP ${err.status})`;
          delay = Math.max(err.retryAfterMs ?? 0, backoffMs(this.pollFailures, BLOCKED_BASE_MS, BLOCKED_MAX_MS));
        } else {
          delay = Math.max(this.nextPollSlot(), backoffMs(this.pollFailures, this.pollIntervalMs, RECONNECT_MAX_MS));
        }
      }
      this.evaluateHealth();
      if (this.running && this.runId === run) this.schedulePoll(delay);
    });
  }

  /** Time until the next wall-clock slot `phase + k × interval`, so timer lateness never accumulates. */
  private nextPollSlot(): number {
    const interval = this.pollIntervalMs;
    const offset = (((Date.now() - this.pollPhaseMs) % interval) + interval) % interval;
    return interval - offset;
  }

  /** One read of SMP, the uncached price origin, for a batch of markets (main lines and props alike). */
  private async postSmp(batch: string[], dispatcher = this.http): Promise<JsonResponse<FdPriceUpdate[]>> {
    const url = `https://smp.${this.region}.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0`;
    const res = await this.getJson<FdPriceUpdate[]>(url, { method: 'POST', body: JSON.stringify({ marketIds: batch }), timeoutMs: POLL_TIMEOUT_MS, dispatcher });
    // An empty answer to a non-empty request is a failure, not proof the prices are current.
    if (!Array.isArray(res.data) || !res.data.length) throw new Error(`SMP returned no markets for ${batch.length} requested`);
    return res;
  }

  private async fetchPrices(ids: string[], channel: Channel): Promise<void> {
    if (!ids.length) return;
    await Promise.all(
      chunk(ids, POLL_BATCH).map(async (batch) => {
        const res = await this.postSmp(batch);
        this.touch(res.receivedAt);
        if (channel === 'poll') this.lastPollOkAt = res.receivedAt;
        const returned = new Set<string>();
        for (const update of res.data) {
          returned.add(update.marketId);
          this.applyPrices(update, channel, res.receivedAt);
        }
        this.noteMissing(batch.filter((id) => !returned.has(id)));
      }),
    );
  }

  /** SMP leaves closed markets out of its answer; a market missing from consecutive polls is gone. Returned markets reset in `applyPrices`. */
  private noteMissing(missing: string[]): void {
    const closed: TrackedMarket[] = [];
    for (const id of missing) {
      const m = this.markets.get(id);
      if (m && ++m.missedPolls >= MISSED_POLLS_BEFORE_CLOSED) closed.push(m);
    }
    if (!closed.length) return;
    for (const m of closed) this.closeMarket(m);
    this.commit({ removedQuotes: closed.flatMap(refsFor), removedGames: this.retireEmptyEvents() });
    this.requestDiscovery(`${closed.length} market(s) no longer priced`);
  }

  /** Stop tracking a closed market, and keep the board refresh from re-adopting it for CLOSED_TOMBSTONE_MS. */
  private closeMarket(m: TrackedMarket): void {
    this.markets.delete(m.marketId);
    this.closedMarkets.set(m.marketId, Date.now());
  }

  // ---------------------------------------------------------------- PIR push

  /**
   * Open the PIR socket (AppSync's `graphql-ws` protocol, authenticated by FD's public client key in the
   * URL): `connection_init` → `connection_ack`, then `start` per subscription batch → `start_ack`, then
   * `data` messages; `ka` keepalives every 60 s. Reconnects with backoff on any close.
   */
  private connectPush(): void {
    if (!this.running || this.ws) return;
    const epoch = ++this.pushEpoch;
    const host = `pir.${this.region}.sportsbook.fanduel.com`;
    const url = `wss://${host}/graphql/realtime?header=${b64(this.pirAuth())}&payload=${b64({})}`;
    const ws = new WebSocket(url, ['graphql-ws'], {
      headers: { Origin: 'https://sportsbook.fanduel.com', 'User-Agent': BROWSER_UA },
      agent: createWsAgent(this.proxyUrl),
      handshakeTimeout: 10_000,
    });
    this.ws = ws;
    this.wsAcked = false;
    this.liveSubs = [];
    this.liveSignature = '';
    this.nextSubs = null;
    const current = () => this.pushEpoch === epoch && this.ws === ws;
    let watchdog: NodeJS.Timeout | undefined;
    let openedAt = 0;
    let rejectedStatus: number | undefined;

    ws.on('unexpected-response', (_req, res) => {
      rejectedStatus = res.statusCode;
      if (current()) this.log(`PIR upgrade rejected: HTTP ${res.statusCode}`);
      ws.terminate();
    });
    ws.on('open', () => {
      if (!current()) return;
      openedAt = this.wsLastSeenAt = Date.now();
      ws.send(JSON.stringify({ type: 'connection_init' }));
      let ticks = 0;
      watchdog = setInterval(() => {
        if (!current()) return clearInterval(watchdog);
        if (Date.now() - this.wsLastSeenAt > SILENCE_TIMEOUT_MS) {
          this.log(`PIR silent for ${SILENCE_TIMEOUT_MS / 1000}s, terminating`);
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
      const at = Date.now();
      this.wsLastSeenAt = at;
      let msg: { type?: string; id?: string; payload?: any };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'connection_ack':
          this.wsAcked = true;
          this.pushBlocked = null;
          if (this.keyProblem?.startsWith('push key')) this.keyProblem = null;
          this.log(`PIR connected (server keepalive timeout ${msg.payload?.connectionTimeoutMs ?? '?'}ms)`);
          this.syncSubscriptions();
          this.evaluateHealth();
          break;
        case 'ka':
          this.touch(at);
          break;
        case 'start_ack':
          if (msg.id) this.onSubscriptionAck(msg.id);
          break;
        case 'data': {
          this.touch(at);
          const update = msg.payload?.data?.onUpdateMarketPrice as FdPriceUpdate | undefined;
          if (update) this.applyPrices(update, 'push', at);
          break;
        }
        case 'error':
        case 'complete':
          if (msg.type === 'error') {
            this.log(`PIR subscription error: ${JSON.stringify(msg.payload).slice(0, 300)}`);
            if (isUnauthorized(msg.payload)) this.onPushKeyRejected();
          }
          if (msg.id) this.onSubscriptionFailed(msg.id);
          break;
        case 'connection_error':
          // A rotated client key answers `connection_error` with UnauthorizedException (errorCode 401).
          this.log(`PIR connection_error: ${JSON.stringify(msg.payload).slice(0, 300)}`);
          if (isUnauthorized(msg.payload)) this.onPushKeyRejected();
          ws.terminate();
          break;
      }
    });
    ws.on('error', (err) => {
      if (current()) this.log(`PIR socket error: ${err.message}`);
    });
    ws.on('close', (code) => {
      clearInterval(watchdog);
      if (!current()) return;
      this.ws = null;
      this.wsAcked = false;
      this.liveSubs = [];
      this.liveSignature = '';
      this.nextSubs = null;
      if (!this.running) return;
      if (openedAt && Date.now() - openedAt > STABLE_CONNECTION_MS) this.wsAttempt = 0;
      const attempt = ++this.wsAttempt;
      const blocked = rejectedStatus === 401 || rejectedStatus === 403 || rejectedStatus === 429;
      this.pushBlocked = blocked ? `push blocked (HTTP ${rejectedStatus})` : null;
      const delay = blocked ? backoffMs(attempt, BLOCKED_BASE_MS, BLOCKED_MAX_MS) : backoffMs(attempt, RECONNECT_BASE_MS, RECONNECT_MAX_MS);
      this.log(`PIR closed (${rejectedStatus ? `HTTP ${rejectedStatus}` : code}), reconnecting in ${delay}ms`);
      this.evaluateHealth();
      this.timeout(delay, () => this.connectPush());
    });
  }

  /**
   * Keep the subscriptions equal to the tracked market set. A replacement set is started first and
   * the old one is stopped only once every new subscription is acknowledged, so a rejected start
   * never leaves push dark.
   */
  private syncSubscriptions(): void {
    const ws = this.ws;
    if (!ws || !this.wsAcked || ws.readyState !== WebSocket.OPEN) return;
    const ids = [...this.markets.keys()].sort();
    const signature = ids.join(',');
    if (signature === (this.nextSubs?.signature ?? this.liveSignature)) return;
    if (this.nextSubs) for (const id of this.nextSubs.ids) ws.send(JSON.stringify({ id, type: 'stop' }));
    const gen = { ids: [] as string[], acked: new Set<string>(), signature };
    for (const batch of chunk(ids, SUBSCRIPTION_BATCH)) {
      const id = randomUUID();
      gen.ids.push(id);
      ws.send(
        JSON.stringify({
          id,
          type: 'start',
          payload: { data: JSON.stringify({ query: PIR_SUBSCRIPTION, variables: { ids: batch } }), extensions: { authorization: this.pirAuth() } },
        }),
      );
    }
    this.nextSubs = gen.ids.length ? gen : null;
    if (!gen.ids.length) this.promoteSubscriptions(gen);
  }

  /** A `start_ack` for the replacement set; once every batch is acknowledged, the set takes over. */
  private onSubscriptionAck(id: string): void {
    const gen = this.nextSubs;
    if (!gen || !gen.ids.includes(id)) return;
    gen.acked.add(id);
    if (gen.acked.size === gen.ids.length) this.promoteSubscriptions(gen);
  }

  /** Make `gen` the live set and only then stop the old one (make-before-break). */
  private promoteSubscriptions(gen: { ids: string[]; signature: string }): void {
    for (const old of this.liveSubs) this.ws?.send(JSON.stringify({ id: old, type: 'stop' }));
    this.liveSubs = gen.ids;
    this.liveSignature = gen.signature;
    this.nextSubs = null;
    this.subscribeAttempt = 0;
    this.evaluateHealth();
  }

  /** A start was rejected or a live subscription ended: keep what still works and retry with backoff. */
  private onSubscriptionFailed(id: string): void {
    const ws = this.ws;
    if (this.nextSubs?.ids.includes(id)) {
      for (const other of this.nextSubs.ids) if (other !== id) ws?.send(JSON.stringify({ id: other, type: 'stop' }));
      this.nextSubs = null;
    } else if (this.liveSubs.includes(id)) {
      this.liveSubs = this.liveSubs.filter((x) => x !== id);
      this.liveSignature = '';
    } else {
      return;
    }
    const delay = backoffMs(++this.subscribeAttempt, SUBSCRIBE_RETRY_BASE_MS, RECONNECT_MAX_MS);
    this.log(`PIR subscription ${id.slice(0, 8)} failed; resubscribing in ${delay}ms`);
    this.timeout(delay, () => this.syncSubscriptions());
    this.evaluateHealth();
  }

  /** Push is delivering: the socket is acknowledged and at least one subscription is live. */
  private get pushLive(): boolean {
    return this.wsAcked && this.liveSubs.length > 0;
  }

  private onPushKeyRejected(): void {
    this.keyProblem = 'push key rejected (UnauthorizedException)';
    void this.refreshKeys('FanDuel rejected the push key');
  }

  /** AppSync's API-key auth object: sent (base64) in the socket URL and with every `start`. */
  private pirAuth() {
    return { Authorization: this.pirKey, host: `pir.${this.region}.sportsbook.fanduel.com` };
  }

  // ---------------------------------------------------------------- normalization

  /**
   * Apply one market's full price state from either channel. Both deliver complete market state
   * (never deltas), so whichever observation `MarketMerge` accepts fully replaces what we show.
   */
  private applyPrices(update: FdPriceUpdate, channel: Channel, receivedAt: number): void {
    const m = this.markets.get(update.marketId);
    if (!m) return;
    m.missedPolls = 0;

    if (update.marketStatus === 'CLOSED') {
      this.closeMarket(m);
      this.commit({ removedQuotes: refsFor(m), removedGames: this.retireEmptyEvents() });
      return;
    }

    const bookTime = channel === 'push' && update.updatedAt ? Date.parse(update.updatedAt) : null;
    const inPlay = update.inplay ?? m.inPlay;
    const marketOpen = update.marketStatus === undefined || update.marketStatus === 'OPEN';
    const quotes: Quote[] = [];
    for (const r of update.runnerDetails ?? []) {
      const side = m.sides.get(r.selectionId);
      if (!side) {
        if (!m.warnedUnknownRunner) {
          m.warnedUnknownRunner = true;
          this.log(`market ${m.marketId}: unknown runner ${r.selectionId}; refreshing the board`);
          this.requestDiscovery(`unknown runner in ${m.marketId}`);
        }
        continue;
      }
      const american = runnerAmerican(r);
      if (american === null) continue;
      quotes.push({
        book: this.book,
        gameKey: m.gameKey,
        market: m.type,
        side,
        line: m.type === 'moneyline' ? null : (r.handicap ?? null),
        american,
        decimal: r.winRunnerOdds?.trueOdds?.decimalOdds?.decimalOdds ?? americanToDecimal(american),
        suspended: !marketOpen || runnerInactive(r),
        live: inPlay,
        bookTime,
        receivedAt,
        channel,
      });
    }

    const accepted = m.merge.offer(channel, signatureOf(update, inPlay), bookTime);
    this.emitSamples(quotes, accepted);
    if (!accepted) return;

    const games: BookGame[] = [];
    if (inPlay !== m.inPlay) {
      m.inPlay = inPlay;
      const game = this.events.get(m.eventId);
      const live = [...this.markets.values()].some((x) => x.eventId === m.eventId && x.inPlay);
      if (game && game.live !== live) {
        const next = { ...game, live };
        this.events.set(m.eventId, next);
        games.push(next);
      }
    }
    this.commit({ games, quotes });
  }

  // ---------------------------------------------------------------- player props (on demand)

  /**
   * One group of player props for an FD game. The event page's tab names the markets (players, lines),
   * but it is CDN-cached like the board (15 s + 60 s stale-while-revalidate), so it is re-read only every
   * PROP_PAGE_TTL_MS and, as for main lines, never used for prices: those come from the uncached SMP
   * origin, and a read SMP can't price fails (the props service then keeps the last good one, marked).
   */
  async fetchProps(game: BookGame, group: PropGroup): Promise<BookProp[]> {
    const markets = await this.propMarkets(game.bookEventId, group);
    if (!markets.length) return [];
    return parseFdProps(markets, await this.readPrices(markets.map((m) => m.marketId)), game);
  }

  /** The group's prop markets on its event-page tab, from a read at most PROP_PAGE_TTL_MS old. */
  private async propMarkets(eventId: string, group: PropGroup): Promise<FdMarket[]> {
    const now = Date.now();
    for (const [key, p] of this.propPages) if (now - p.at > PROP_PAGE_EVICT_MS) this.propPages.delete(key);
    const key = `${eventId}|${group}`;
    const cached = this.propPages.get(key);
    if (cached && now - cached.at < PROP_PAGE_TTL_MS) return cached.markets;
    const all = Object.values((await this.readEventPage(eventId, PROP_TABS[group])).attachments?.markets ?? {});
    // A tab can carry another group's stat (receiving lists rush + receiving yards); that tab prices it.
    const markets = all.filter((m) => {
      const stat = fdPropStat(m);
      return stat !== null && PROP_STATS[stat].group === group;
    });
    // Player-prop markets but none of a type we read: FD has likely renamed them, which would otherwise
    // look exactly like a game with no props posted.
    const unread = all.filter((m) => fdPropStat(m) === null && /^PLAYER_X_(?!ALT_)|TOUCHDOWN_SCORER/.test(m.marketType));
    if (!markets.length && unread.length && !this.warnedPropTypes.has(group)) {
      this.warnedPropTypes.add(group);
      this.log(`props: the ${group} tab lists ${unread.length} player-prop markets, none of a type we read (${[...new Set(unread.map((m) => m.marketType))].slice(0, 5).join(', ')})`);
    }
    this.propPages.set(key, { markets, at: now });
    return markets;
  }

  /**
   * One tab of an event page. A rejected app key isn't refreshed here: discovery adopts FD's current one
   * within its next run, and FD answers other errors with the same body, which must not use up the
   * refresh discovery may need.
   */
  private async readEventPage(eventId: string, tab: string): Promise<FdPage> {
    const url = `${this.sbapi}/event-page?eventId=${encodeURIComponent(eventId)}&tab=${tab}&timezone=${TIMEZONE}&_ak=${this.appKey}`;
    const page = (await this.getJson<FdPage>(url, { timeoutMs: DISCOVERY_TIMEOUT_MS, dispatcher: this.propsHttp })).data;
    // Like the board, a page without attachments is an error page, not an event with no props.
    if (!page.attachments) throw new Error('event page has no attachments');
    return page;
  }

  /** SMP prices for the given markets, by market id. A refusal wins over other failures, so the caller backs off. */
  private async readPrices(ids: string[]): Promise<Map<string, FdPriceUpdate>> {
    const out = new Map<string, FdPriceUpdate>();
    const reads = await Promise.allSettled(chunk(ids, POLL_BATCH).map((batch) => this.postSmp(batch, this.propsHttp)));
    const failed = reads.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    if (failed.length) throw failed.find(isBlocked) ?? failed[0];
    for (const r of reads) if (r.status === 'fulfilled') for (const update of r.value.data) out.set(update.marketId, update);
    return out;
  }

  /** FD's board and event-page API for this region. */
  private get sbapi(): string {
    return `https://sbapi.${this.region}.sportsbook.fanduel.com/api`;
  }

  // ---------------------------------------------------------------- health & plumbing

  /**
   * Derive the status from both channels. No markets: down if the board refresh is failing, else
   * connecting. Neither push nor polling working: connecting during the startup grace, else down.
   * Otherwise degraded if anything is wrong (e.g. push down while polls work), else live.
   */
  private evaluateHealth(): void {
    if (!this.running) return;
    const now = Date.now();
    const pushOk = this.push && this.pushLive && now - this.wsLastSeenAt < SILENCE_TIMEOUT_MS;
    const pollOk = this.pollIntervalMs > 0 && this.pollFailures === 0 && now - this.lastPollOkAt < Math.max(3 * this.pollIntervalMs, 5_000);
    // A channel that has not had its first chance to connect or poll yet is pending, not failing.
    const warmingUp = now - this.startedAt < STARTUP_GRACE_MS;
    const problems: string[] = [];
    if (this.keyProblem) problems.push(`${this.keyProblem}${this.keyRefresh ? '; refreshing keys' : ''}`);
    if (this.push && !pushOk && !warmingUp) problems.push(this.pushBlocked ?? 'push disconnected');
    if (this.pollIntervalMs > 0 && !pollOk && !warmingUp) problems.push(this.pollBlocked ?? 'polling failing');
    if (this.discoveryFailures >= 3) problems.push('board refresh failing');

    if (!this.markets.size) this.setStatus(this.discoveryFailures ? 'down' : 'connecting', problems.join('; ') || 'no NFL markets listed');
    else if (!pushOk && !pollOk) this.setStatus(warmingUp ? 'connecting' : 'down', problems.join('; ') || null);
    else this.setStatus(problems.length ? 'degraded' : 'live', problems.join('; ') || null);
  }

  /** Every second: expire closed-market tombstones and re-derive health (silence counts even without events). */
  private housekeeping(): void {
    const now = Date.now();
    for (const [id, at] of this.closedMarkets) if (now - at > CLOSED_TOMBSTONE_MS) this.closedMarkets.delete(id);
    this.evaluateHealth();
  }

  /** A JSON request with the headers FD's own site sends (on the main pool unless told otherwise). */
  private getJson<T>(url: string, init: { method?: 'GET' | 'POST'; body?: string; timeoutMs: number; dispatcher?: Dispatcher }) {
    return requestJson<T>(url, {
      dispatcher: init.dispatcher ?? this.http,
      method: init.method,
      body: init.body,
      timeoutMs: init.timeoutMs,
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        Origin: 'https://sportsbook.fanduel.com',
        Referer: 'https://sportsbook.fanduel.com/',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  }

  /** A plain-text GET (FD's app shell and JS bundle, for `readKeysFromBundle`). */
  private async getText(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9', Referer: `${SITE}/` },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      ...({ dispatcher: this.http } as RequestInit),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, url, text);
    return text;
  }

  /** A timer that `stop()` cancels, and that does nothing if it fires after a stop. */
  private timeout(ms: number, fn: () => void | Promise<void>): NodeJS.Timeout {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) void fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  /** Run `fn` every `ms`, measured from the end of the previous run (so runs never overlap); errors are logged. */
  private every(ms: number, fn: () => void | Promise<void>): void {
    const run = this.runId;
    this.timeout(ms, async () => {
      try {
        await fn();
      } catch (err) {
        this.log(`periodic task failed: ${errMsg(err)}`);
      } finally {
        if (this.running && this.runId === run) this.every(ms, fn);
      }
    });
  }
}

/**
 * Read FanDuel's current public keys from its live web bundle. The HTML routes are behind
 * PerimeterX, but non-HTML paths such as `/sw.js` return the app shell, which names the main bundle.
 * The app key sits in the bundle's API-key maps (`{[X.FANDUEL]: …}`, prod and dev, as literals or
 * variables declared just before); the PIR key in the US production AppSync config. Candidates are
 * returned unvalidated; the caller tests them against the live API.
 */
export async function readKeysFromBundle(getText: (url: string) => Promise<string>): Promise<{ appKeys: string[]; pirKey: string | null }> {
  const shell = await getText(`${SITE}/sw.js`);
  const main = shell.match(/\/static\/js\/main\.[\w-]+\.js/)?.[0];
  if (!main) throw new Error('main bundle not found in the app shell');
  const js = await getText(`${SITE}${main}`);
  const appKeys = new Set<string>();
  for (const m of js.matchAll(/\[[\w$]+\.FANDUEL\]:(?:"([A-Za-z0-9]{8,40})"|([A-Za-z_$][\w$]*))/g)) {
    if (m[1]) appKeys.add(m[1]);
    else if (m[2]) {
      const before = js.slice(Math.max(0, m.index - 4_000), m.index);
      const defs = [...before.matchAll(new RegExp(`[,;{\\s]${m[2].replace(/\$/g, '\\$')}="([A-Za-z0-9]{8,40})"`, 'g'))];
      const value = defs.at(-1)?.[1];
      if (value) appKeys.add(value);
    }
  }
  // The config object itself contains "{REGION}", so scan a bounded window rather than "up to the next brace".
  const pirKey = js.match(/"https:\/\/pir\.\{REGION\}\.sportsbook\.fanduel\.com\/graphql"[\s\S]{0,600}?aws_appsync_clientId:"([^"]+)"/)?.[1] ?? null;
  return { appKeys: [...appKeys], pirKey };
}

/**
 * FD answers a rejected or missing `_ak` with exactly `{"error":true}`: 404 on the board, 400 when
 * missing, 500 on in-play. A WAF block is a 403 HTML page, so the exact body keeps the two apart.
 */
function isKeyRejection(err: unknown): err is HttpError {
  return err instanceof HttpError && [400, 404, 500].includes(err.status) && err.body.trim() === '{"error":true}';
}

/** AppSync reports a rejected key as an `UnauthorizedException` somewhere in the error payload. */
const isUnauthorized = (payload: unknown) => JSON.stringify(payload ?? '').includes('UnauthorizedException');

/** Identity of a market's displayed state: status, in-play flag, and every runner's line, price and status. */
export function signatureOf(update: FdPriceUpdate, inPlay: boolean): string {
  const runners = (update.runnerDetails ?? [])
    .map((r) => `${r.selectionId}:${r.handicap ?? ''}:${r.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ?? r.winRunnerOdds?.americanDisplayOdds?.americanOdds ?? ''}:${r.runnerStatus ?? ''}`)
    .sort()
    .join(',');
  return `${update.marketStatus ?? ''}|${inPlay}|${runners}`;
}

/** Runner id → side, from the board's runner `result.type` (HOME/AWAY/OVER/UNDER). */
function sidesOf(m: FdMarket): Map<number, Side> {
  const sides = new Map<number, Side>();
  for (const r of m.runners ?? []) {
    const side = RESULT_SIDES[r.result?.type ?? ''];
    if (side) sides.set(r.selectionId, side);
  }
  return sides;
}

function refsFor(m: TrackedMarket): QuoteRef[] {
  return quoteRefsFor(m.gameKey, m.type);
}

/** The game's teams from a moneyline or spread market's runner names, else from the event name ("Away @ Home"). */
function teamsOf(ev: FdEvent, markets: FdMarket[]): { away: Team; home: Team } | null {
  for (const m of markets) {
    if (m.marketType === 'TOTAL_POINTS_(OVER/UNDER)') continue;
    const away = m.runners?.find((r) => r.result?.type === 'AWAY');
    const home = m.runners?.find((r) => r.result?.type === 'HOME');
    const a = resolveTeam(away?.runnerName);
    const h = resolveTeam(home?.runnerName);
    if (a && h) return { away: a, home: h };
  }
  const [awayName, homeName] = ev.name.split(' @ ');
  const a = resolveTeam(awayName);
  const h = resolveTeam(homeName);
  return a && h ? { away: a, home: h } : null;
}

/**
 * Player props from an FD event page's markets, priced by SMP's answer (`prices`, by market id): the
 * cached page names the markets and players, SMP prices them. `teams` (the game's team codes) places
 * each player by the team in their runner's logo.
 */
export function parseFdProps(markets: readonly FdMarket[], prices: ReadonlyMap<string, FdPriceUpdate>, teams: Pick<BookGame, 'away' | 'home'>): BookProp[] {
  const out: BookProp[] = [];
  for (const m of markets) {
    const stat = fdPropStat(m);
    if (stat === null) continue;
    const smp = prices.get(m.marketId);
    // SMP's runner fields (price, handicap, status) replace the cached page's; names and logos stay.
    const runners = (m.runners ?? []).map((r) => {
      const fresh = smp?.runnerDetails?.find((x) => x.selectionId === r.selectionId);
      return fresh ? { ...r, ...fresh } : r;
    });
    // SMP leaves closed markets out of its answer, and the cached page can still list one, so a market
    // SMP answered without is shown as not open rather than at the page's price.
    const marketOpen = smp !== undefined && (smp.marketStatus ?? m.marketStatus ?? 'OPEN') === 'OPEN';
    if (PROP_STATS[stat].kind === 'yes') {
      for (const r of runners) {
        const american = runnerAmerican(r);
        // Scorer markets also list "Seattle Defense" (flagged a player selection all the same).
        if (r.isPlayerSelection === false || !r.runnerName || TEAM_RUNNER.test(r.runnerName) || american === null) continue;
        out.push({ stat, player: r.runnerName.trim(), team: fdTeamSide(r, teams), line: null, prices: { yes: american }, suspended: !marketOpen || runnerInactive(r) });
      }
      continue;
    }
    const over = runners.find((r) => r.result?.type === 'OVER');
    const under = runners.find((r) => r.result?.type === 'UNDER');
    const line = over?.handicap ?? under?.handicap;
    const player = m.marketName?.split(' - ')[0]?.trim(); // "Patrick Mahomes - Passing Yds"
    const sides = ouPrices(over ? runnerAmerican(over) : null, under ? runnerAmerican(under) : null);
    // Both sides must quote one line (a partial SMP answer could pair a fresh over with the page's old under).
    if (line === undefined || !Number.isFinite(line) || (over && under && over.handicap !== under.handicap) || !player || sides === null) continue;
    out.push({
      stat,
      player,
      team: fdTeamSide(over ?? under, teams),
      line,
      prices: sides,
      suspended: !marketOpen || [over, under].some((r) => r !== undefined && runnerInactive(r)),
    });
  }
  return out;
}

/** Which prop stat an FD market prices, or null for anything else (alt ladders, specials, game lines). */
function fdPropStat(m: FdMarket): PropStat | null {
  const yes = FD_YES_STATS[m.marketType];
  if (yes) return yes;
  const ou = /^PLAYER_X_(?!ALT_)(.+?)(?:_(?:HIGH|MEDIUM|LOW))?$/.exec(m.marketType)?.[1];
  return ou === undefined ? null : (FD_OU_STATS[ou] ?? null);
}

const runnerAmerican = (r: FdRunner) => parseAmerican(r.winRunnerOdds?.americanDisplayOdds?.americanOddsInt ?? r.winRunnerOdds?.americanDisplayOdds?.americanOdds);
/** A runner FD has stopped taking bets on (any status but ACTIVE). */
const runnerInactive = (r: FdRunner) => r.runnerStatus !== undefined && r.runnerStatus !== 'ACTIVE';
/** A team, not a player, among a scorer market's runners ("Seattle Defense"). */
const TEAM_RUNNER = /\b(defen[cs]e|d\/st)$/i;

/** The player's side of the game, from the team in their runner's jersey logo (`…/team/nfl/kansas_city_chiefs_jersey.png`). */
function fdTeamSide(r: FdRunner | undefined, teams: Pick<BookGame, 'away' | 'home'>): 'away' | 'home' | null {
  const slug = r?.logo?.match(/\/team\/nfl\/([a-z0-9_]+?)(?:_jersey)?\.png/i)?.[1];
  const team = slug ? resolveTeam(slug.replace(/_/g, ' ')) : null;
  return team?.code === teams.away ? 'away' : team?.code === teams.home ? 'home' : null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** JSON → base64 → URL-encoded, the form AppSync's realtime URL takes for `header` and `payload`. */
const b64 = (value: unknown) => encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64'));
