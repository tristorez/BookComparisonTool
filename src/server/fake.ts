/**
 * Synthetic book for offline dev, tests, drills and load tests (`BOOKS=fake`), shaped like the real
 * connectors' output: the same `change`/`sample`/`status` events, book timestamps at the real books'
 * resolution, and failure modes for the resilience drills.
 *
 * Prices are a pure function of (seed, book, wall-clock tick), so every process with the same seed and
 * rate watches one book: two feeds over a fake book report the same states with the same book times, as
 * Box A and Box B do for a real one, and a process that starts late snapshots what the others hold.
 */
import { gameKey, NFL_TEAMS } from '../books/teams.js';
import { BookConnector, type BookGame, type BookProp, type Quote, type QuoteRef } from '../books/types.js';
import { BOOK_IDS, MARKET_SIDES, type BookId, type Channel, type MarketType, type Side } from '../shared/domain.js';
import { americanToDecimal } from '../shared/odds.js';
import { PROP_STATS, type PropGroup, type PropStat } from '../shared/props.js';
import type { BookSpec } from './registry.js';

export type FakeMode = 'normal' | 'fail' | 'freeze' | 'garbage' | 'massRemove';

export interface FakeOptions {
  seed?: number;
  /** Price changes per second across the slate. */
  ratePerSec?: number;
  mode?: FakeMode;
  games?: number;
  /** For `fail`/`freeze`/`massRemove`: when the misbehavior starts. */
  troubleAfterMs?: number;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One tick's draws: the same (seed, tick) gives the same numbers in every process. */
const drawsAt = (seed: number, tick: number) => mulberry32(Math.imul(seed, 0x9e3779b1) ^ Math.imul(tick, 0x85ebca6b));

/** How far back a starting process looks for each market's latest change before using its opening. */
const LOOKBACK_TICKS = 20_000;

/**
 * A well-mixed 32-bit seed from a string: FNV-1a, then murmur3's finalizer. Without the finalizer,
 * mulberry32 seeded per prop via `drawsAt` gave nearly the same second draw for every prop in a minute.
 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Synthetic roster for `fetchProps`: each role's typical over/under lines and its fair chance of an anytime TD. */
const FAKE_ROSTER: readonly { role: string; lines: Partial<Record<PropStat, number>>; td: number }[] = [
  { role: 'QB', lines: { pass_yds: 235, pass_tds: 1.5, pass_cmp: 21, pass_att: 33, pass_int: 0.5, rush_yds: 14 }, td: 0.12 },
  { role: 'RB', lines: { rush_yds: 64, rush_att: 15, rush_rec_yds: 82, receptions: 2.5 }, td: 0.45 },
  { role: 'WR1', lines: { rec_yds: 66, receptions: 5.5 }, td: 0.38 },
  { role: 'WR2', lines: { rec_yds: 44, receptions: 3.5 }, td: 0.25 },
  { role: 'TE', lines: { rec_yds: 34, receptions: 3.5 }, td: 0.27 },
];
/** Each scorer market's fair chance, from the anytime chance `p`. */
const FAKE_TD_ODDS: Partial<Record<PropStat, (p: number) => number>> = {
  td_anytime: (p) => p,
  td_first: (p) => p * 0.2,
  td_last: (p) => p * 0.2,
  td_2plus: (p) => p * p * 0.35,
};

interface FakeMarket {
  line: number | null;
  prices: Record<string, number>;
}

/** A market's opening; every later state is drawn around it. */
interface Opening {
  key: string; // gameKey|market
  game: BookGame;
  type: MarketType;
  line: number | null;
  pFirst: number; // fair probability of the first side (away, or over)
}

/** Prices for a two-way market around a fair probability, with ~4.5% hold. */
function twoWay(pFirst: number): [number, number] {
  const hold = 1.045;
  const toAmerican = (p: number) => {
    const implied = Math.min(0.97, Math.max(0.03, p * hold));
    const dec = 1 / implied;
    const a = dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
    return Math.abs(a) < 100 ? (a < 0 ? -100 : 100) : a;
  };
  return [toAmerican(pFirst), toAmerican(1 - pFirst)];
}

function priced(type: MarketType, line: number | null, pFirst: number): FakeMarket {
  const [first, second] = MARKET_SIDES[type];
  const [a, b] = twoWay(Math.min(0.95, Math.max(0.05, pFirst)));
  return { line, prices: { [first]: a, [second]: b } };
}

export class FakeConnector extends BookConnector {
  readonly book: BookId;
  // The real book's shape, copied from its BookSpec: how often our polling beats push, and the
  // resolution of its timestamps.
  private readonly pollShare: number;
  private readonly bookTimeResolutionMs: number;
  private readonly opts: Required<FakeOptions>;
  private readonly tickMs: number;
  private readonly bookIndex: number;
  private readonly bookSeed: number;
  /** Misbehavior is per process, so it has its own generator. */
  private readonly glitch: () => number;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly games: BookGame[] = [];
  private readonly openings: Opening[] = [];
  private readonly markets = new Map<string, FakeMarket>(); // gameKey|market
  private running = false;
  private startedAt = 0;
  /** The last wall-clock tick applied (tick k covers [k·tickMs, (k+1)·tickMs)). */
  private lastTick = 0;
  /** `massRemove` mode: the quotes already pulled (they are pulled once, then nothing moves). */
  private removed: QuoteRef[] = [];

  /** A synthetic book shaped like `spec` (registry.ts). */
  constructor(spec: BookSpec, opts: FakeOptions = {}) {
    super();
    const book = spec.id;
    this.book = book;
    this.pollShare = spec.pollShare ?? 0;
    this.bookTimeResolutionMs = spec.bookTimeResolutionMs;
    this.opts = { seed: 7, ratePerSec: 4, mode: 'normal', games: 8, troubleAfterMs: 15_000, ...opts };
    this.tickMs = Math.max(10, Math.round(1000 / this.opts.ratePerSec));
    // Every book shares the slate (same seed) but draws its own prices, offset by its place in BOOK_IDS.
    this.bookIndex = BOOK_IDS.indexOf(book);
    this.bookSeed = this.opts.seed * 31 + this.bookIndex + 1;
    this.glitch = mulberry32(this.bookSeed + 0x5bd1e995);
    const slate = mulberry32(this.opts.seed);
    // Kickoffs hang off the UTC day, so processes started the same day agree on every game.
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const teams = [...NFL_TEAMS];
    for (let i = 0; i < this.opts.games && teams.length >= 2; i++) {
      const away = teams.splice(Math.floor(slate() * teams.length), 1)[0]!;
      const home = teams.splice(Math.floor(slate() * teams.length), 1)[0]!;
      const live = i < 2;
      const start = new Date(day + (live ? -3_600_000 : (i - 1) * 86_400_000 + 3_600_000)).toISOString();
      const game: BookGame = { book, gameKey: gameKey(away, home, start), bookEventId: `fake-${book}-${i}`, away: away.code, home: home.code, startTime: start, live };
      this.games.push(game);
      const spread = -(Math.round(slate() * 14) + 0.5) * (slate() < 0.5 ? 1 : -1); // the home line
      const pHome = Math.min(0.85, Math.max(0.15, 0.5 - spread / 28));
      const total = Math.round(37 + slate() * 16) + 0.5;
      this.openings.push(
        { key: `${game.gameKey}|moneyline`, game, type: 'moneyline', line: null, pFirst: 1 - pHome },
        { key: `${game.gameKey}|spread`, game, type: 'spread', line: spread, pFirst: 0.5 },
        { key: `${game.gameKey}|total`, game, type: 'total', line: total, pFirst: 0.5 },
      );
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.removed = [];
    this.setStatus('connecting');
    this.after(300, () => {
      this.lastTick = Math.floor(Date.now() / this.tickMs);
      this.restore(this.lastTick);
      const all = this.allQuotes('snapshot');
      this.emitSamples(all, true);
      this.commit({ games: this.games, quotes: all });
      this.setStatus('live');
      this.scheduleTick();
    });
    this.every(500, () => {
      if (this.troubled('fail')) {
        this.setStatus('down', 'fake outage');
        return;
      }
      this.touch();
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.setStatus('stopped');
  }

  /**
   * Synthetic player props for one of this book's games, shaped like the real books': a few players a
   * team, lines shared by every book (seed) and nudged per book, prices redrawn each minute so a read can
   * move, and books after the first skip some props, as FanDuel lists fewer stats than DraftKings.
   */
  async fetchProps(game: BookGame, group: PropGroup): Promise<BookProp[]> {
    const minute = Math.floor(Date.now() / 60_000);
    const out: BookProp[] = [];
    for (const team of ['away', 'home'] as const) {
      const nickname = NFL_TEAMS.find((t) => t.code === game[team])?.nickname ?? game[team];
      for (const { role, lines, td } of FAKE_ROSTER) {
        const player = `${nickname} ${role}`;
        if (group === 'touchdowns') {
          for (const [stat, odds] of Object.entries(FAKE_TD_ODDS) as [PropStat, (p: number) => number][]) {
            const [shared, own] = this.propDraws(game, player, stat, minute);
            if (own === null) continue;
            const p = odds(td * (0.8 + shared() * 0.4)) * (0.95 + own() * 0.1);
            out.push({ stat, player, team, line: null, prices: { yes: twoWay(p)[0] }, suspended: false });
          }
          continue;
        }
        for (const [stat, base] of Object.entries(lines) as [PropStat, number][]) {
          if (PROP_STATS[stat].group !== group) continue;
          const [shared, own] = this.propDraws(game, player, stat, minute);
          if (own === null) continue;
          // Lines drift a little by game and land on .5; on yardage a book is sometimes a yard off.
          const nudge = base >= 10 && own() < 0.3 ? (own() < 0.5 ? -1 : 1) : 0;
          const line = Math.floor(base * (0.85 + shared() * 0.3)) + 0.5 + nudge;
          const [over, under] = twoWay(0.5 + (own() - 0.5) * 0.08);
          out.push({ stat, player, team, line, prices: { over, under }, suspended: false });
        }
      }
    }
    return out;
  }

  /**
   * One prop's draws: shared by every book (its level), and this book's own for the minute (its line and
   * price), or null when this book doesn't list the prop. Books after the first skip a fixed quarter of them.
   */
  private propDraws(game: BookGame, player: string, stat: PropStat, minute: number): [shared: () => number, own: (() => number) | null] {
    const prop = `${game.gameKey}|${player}|${stat}`;
    const listed = this.bookIndex === 0 || mulberry32(hashString(`${this.bookSeed}|${prop}`))() >= 0.25;
    return [mulberry32(hashString(`${this.opts.seed}|${prop}`)), listed ? mulberry32(hashString(`${this.bookSeed}|${minute}|${prop}`)) : null];
  }

  private troubled(mode: FakeMode): boolean {
    return this.opts.mode === mode && Date.now() - this.startedAt >= this.opts.troubleAfterMs;
  }

  /** Tick k changes one market, chosen and priced by that tick's draws. */
  private changeAt(k: number): { opening: Opening; market: FakeMarket; channel: Channel } {
    const r = drawsAt(this.bookSeed, k);
    const opening = this.openings[Math.floor(r() * this.openings.length)]!;
    const line = opening.line === null ? null : opening.line + (r() < 0.3 ? (r() < 0.5 ? -0.5 : 0.5) : 0);
    const market = priced(opening.type, line, opening.pFirst + (r() - 0.5) * 0.06);
    const channel: Channel = this.pollShare > 0 && r() < this.pollShare ? 'poll' : 'push';
    return { opening, market, channel };
  }

  /** Every market as of tick k: its latest change, found by looking back, else its opening. */
  private restore(k: number): void {
    this.markets.clear();
    for (let t = k; t > k - LOOKBACK_TICKS && this.markets.size < this.openings.length; t--) {
      const { opening, market } = this.changeAt(t);
      if (!this.markets.has(opening.key)) this.markets.set(opening.key, market);
    }
    for (const o of this.openings) if (!this.markets.has(o.key)) this.markets.set(o.key, priced(o.type, o.line, o.pFirst));
  }

  /** Ticks land on wall-clock multiples of tickMs; a late timer catches up on every tick it missed. */
  private scheduleTick(): void {
    this.after(Math.max(0, (this.lastTick + 1) * this.tickMs - Date.now()), () => {
      const due = Math.floor(Date.now() / this.tickMs);
      while (this.lastTick < due) this.tick(++this.lastTick);
      this.scheduleTick();
    });
  }

  private tick(k: number): void {
    if (this.troubled('fail') || this.troubled('freeze')) return;
    if (this.troubled('massRemove')) {
      if (!this.removed.length) {
        this.removed = this.allQuotes('push').slice(0, Math.ceil(this.markets.size * 2 * 0.8)).map((q) => ({ gameKey: q.gameKey, market: q.market, side: q.side }));
        this.commit({ removedQuotes: this.removed });
      }
      return;
    }
    const { opening, market, channel } = this.changeAt(k);
    this.markets.set(opening.key, market);
    const quotes = MARKET_SIDES[opening.type].map((side) => this.quote(opening.game, opening.type, side, market, channel, k * this.tickMs));
    if (this.opts.mode === 'garbage' && this.glitch() < 0.3) quotes[0] = { ...quotes[0]!, american: 50 };
    this.emitSamples(quotes, true);
    this.commit({ quotes });
  }

  private allQuotes(channel: Channel): Quote[] {
    const out: Quote[] = [];
    for (const o of this.openings) {
      for (const side of MARKET_SIDES[o.type]) out.push(this.quote(o.game, o.type, side, this.markets.get(o.key)!, channel, Date.now()));
    }
    return out;
  }

  /** `changedAt` is the tick's wall-clock slot: when the book made the change. */
  private quote(game: BookGame, market: MarketType, side: Side, m: FakeMarket, channel: Channel, changedAt: number): Quote {
    const american = m.prices[side]!;
    const line = market === 'moneyline' ? null : market === 'spread' ? (side === 'home' ? m.line! : -m.line!) : m.line;
    // Book timestamps at the real book's resolution (DK milliseconds, FD whole seconds), on push only.
    const res = this.bookTimeResolutionMs;
    const bookTime = channel === 'push' ? (res > 0 ? Math.floor(changedAt / res) * res : changedAt - 40) : null;
    return { book: this.book, gameKey: game.gameKey, market, side, line, american, decimal: americanToDecimal(american), suspended: false, live: game.live, bookTime, receivedAt: Date.now(), channel };
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.running) fn();
    }, ms);
    this.timers.add(t);
  }

  private every(ms: number, fn: () => void): void {
    this.after(ms, () => {
      fn();
      this.every(ms, fn);
    });
  }
}
