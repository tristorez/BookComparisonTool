/**
 * Best Price across books (Decisions.txt D-21..D-23). Pure: no I/O, no clocks.
 *
 *  R1 moneyline: higher payout                                                      exact
 *  R2 spread or total on the same line: higher payout                                exact
 *  R3 pregame spread, different lines, anchor available: highest estimated return
 *     R = P(win)·decimal + P(push), from the books' no-vig consensus + NFL push table  est.
 *  R4 different lines and no model applies (totals, live spreads, no anchor):
 *     better line for the bettor first, then higher payout                          by line
 *  R5 equal displayed price on equal terms: a tie, every book listed                 exact
 *
 * Prices are compared via the displayed American price, never a feed's decimal: books report decimals
 * at different precision (FD PIR 1.87 vs SMP 1.869565), which would split identical prices.
 *
 * The spread model works on the home margin M = home score − away score. Home at line h wins when
 * M > −h and pushes when M = −h; away at line a wins when M < a and pushes when M = a. The anchor is a
 * fair P(M > x) at one half-point x; moving it to another half-point adds or removes the push-table
 * mass of each integer in between.
 */
import type { BookId, MarketType, Side } from './domain.js';
import { americanToDecimal, isValidAmerican } from './odds.js';
import { NFL_PUSH_TABLE, type PushTable } from './pushTable.js';
import type { BestRule } from './wire.js';

/** One book's price for one side of one market. Spread lines are from that side's perspective. */
export interface Offer {
  book: BookId;
  side: Side;
  /** Spread for this side, the total, or null for moneyline. */
  line: number | null;
  american: number;
}

export type TwoSided = Partial<Record<Side, Offer>>;

/** One game's eligible offers (the caller filters out stale, suspended and invalid quotes). */
export interface GameOffers {
  /** In play: pregame push tables do not apply, so spreads fall back to R4. */
  live: boolean;
  books: Partial<Record<BookId, Partial<Record<MarketType, TwoSided>>>>;
}

/** Fair P(M > x) for the home margin M at a half-point x, and the books it came from. */
export interface FairAnchor {
  x: number;
  pAbove: number;
  books: BookId[];
}

/** Combines per-book fair probabilities (already moved to a common x) into one. */
export type FairStrategy = (values: readonly number[]) => number;
export const meanStrategy: FairStrategy = (v) => v.reduce((a, b) => a + b, 0) / v.length;
export const medianStrategy: FairStrategy = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

export interface BestOptions {
  table?: PushTable;
  strategy?: FairStrategy;
  /** Swap the whole anchor (e.g. a sharp-book reference). Defaults to `getFairProbability`. */
  fair?: (game: GameOffers, market: MarketType, opts: BestOptions) => FairAnchor | null;
}

export interface Comparison {
  pick: 'a' | 'b' | 'tie';
  reason: string;
  exact: boolean;
}

export interface BestResult {
  /** The winning offers: several on a tie. */
  offers: Offer[];
  books: BookId[];
  exact: boolean;
  rule: BestRule;
  reason: string;
}

const EPS = 1e-9;
const clamp = (p: number) => Math.min(0.999, Math.max(0.001, p));
const isInt = (x: number) => Math.abs(x - Math.round(x)) < EPS;

// ------------------------------------------------------------------------------------- anchor

/** Total push-table mass of the integers strictly between `lo` and `hi`. */
function massBetween(lo: number, hi: number, table: PushTable): number {
  let sum = 0;
  for (let k = Math.ceil(lo + EPS); k <= Math.floor(hi - EPS); k++) sum += table.pm(k);
  return sum;
}

/** P(M > y) from an anchor at x. */
export function pAboveAt(anchor: Pick<FairAnchor, 'x' | 'pAbove'>, y: number, table: PushTable = NFL_PUSH_TABLE): number {
  if (Math.abs(y - anchor.x) < EPS) return anchor.pAbove;
  return clamp(y > anchor.x ? anchor.pAbove - massBetween(anchor.x, y, table) : anchor.pAbove + massBetween(y, anchor.x, table));
}

/** One book's fair P(M > x) from its two-sided spread market, or null if the market can't anchor. */
export function bookAnchor(home: Offer | undefined, away: Offer | undefined, table: PushTable = NFL_PUSH_TABLE): { x: number; pAbove: number } | null {
  if (!home || !away || home.line === null || away.line === null) return null;
  if (!Number.isFinite(home.line) || Math.abs(home.line + away.line) > EPS) return null; // mid line move: -3.5 / +3
  if (!isValidAmerican(home.american) || !isValidAmerican(away.american)) return null;
  const ih = 1 / americanToDecimal(home.american);
  const ia = 1 / americanToDecimal(away.american);
  const p = ih / (ih + ia); // no-vig P(home covers | no push)
  const t = -home.line;
  return isInt(t) ? { x: t + 0.5, pAbove: clamp(p * (1 - table.pm(t))) } : { x: t, pAbove: clamp(p) };
}

/**
 * Fair anchor for a game's market, or null when no model applies (not a spread, game live, or no
 * book with a consistent two-sided market). Every book's market is moved to a common x first.
 */
export function getFairProbability(game: GameOffers, market: MarketType, opts: BestOptions = {}): FairAnchor | null {
  if (market !== 'spread' || game.live) return null;
  const table = opts.table ?? NFL_PUSH_TABLE;
  const anchors: { book: BookId; x: number; pAbove: number }[] = [];
  for (const book of Object.keys(game.books).sort() as BookId[]) {
    const m = game.books[book]?.spread;
    const a = bookAnchor(m?.home, m?.away, table);
    if (a) anchors.push({ book, ...a });
  }
  if (!anchors.length) return null;
  const x = anchors[0]!.x;
  const values = anchors.map((a) => pAboveAt(a, x, table));
  return { x, pAbove: clamp((opts.strategy ?? meanStrategy)(values)), books: anchors.map((a) => a.book) };
}

// ------------------------------------------------------------------------------------- scoring

/** P(win), P(push) for a spread offer under the anchor. */
export function spreadOutcome(offer: Offer, anchor: FairAnchor, table: PushTable = NFL_PUSH_TABLE): { win: number; push: number } {
  const line = offer.line ?? 0;
  if (offer.side === 'home') {
    const t = -line;
    return isInt(t) ? { win: pAboveAt(anchor, t + 0.5, table), push: table.pm(t) } : { win: pAboveAt(anchor, t, table), push: 0 };
  }
  const a = line;
  return isInt(a) ? { win: 1 - pAboveAt(anchor, a - 0.5, table), push: table.pm(a) } : { win: 1 - pAboveAt(anchor, a, table), push: 0 };
}

/** Estimated return per $1 staked (stake included). */
export function estimatedReturn(offer: Offer, anchor: FairAnchor, table: PushTable = NFL_PUSH_TABLE): number {
  const { win, push } = spreadOutcome(offer, anchor, table);
  return win * americanToDecimal(offer.american) + push;
}

/** Higher is better for the bettor: points taken (spread), a lower total for overs, higher for unders. */
export function lineValue(offer: Offer, market: MarketType): number {
  if (offer.line === null || market === 'moneyline') return 0;
  return market === 'total' && offer.side === 'over' ? -offer.line : offer.line;
}

type Regime = 'payout' | 'model' | 'line';

interface Ranking {
  regime: Regime;
  scores: number[][];
}

function rank(offers: readonly Offer[], market: MarketType, live: boolean, anchor: FairAnchor | null, table: PushTable): Ranking {
  const sameLine = offers.every((o) => o.line === offers[0]!.line);
  const regime: Regime = market === 'moneyline' || sameLine ? 'payout' : market === 'spread' && !live && anchor ? 'model' : 'line';
  const scores = offers.map((o) => {
    const dec = americanToDecimal(o.american);
    if (regime === 'payout') return [dec];
    if (regime === 'model') return [estimatedReturn(o, anchor!, table), lineValue(o, market), dec];
    return [lineValue(o, market), dec];
  });
  return { regime, scores };
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    if (Math.abs(d) > EPS) return d;
  }
  return 0;
}

/** Rank a set of offers for one side of one market. */
export function rankOffers(offers: readonly Offer[], ctx: { market: MarketType; live: boolean; anchor: FairAnchor | null; table?: PushTable }): BestResult | null {
  const valid = offers.filter((o) => isValidAmerican(o.american) && (ctx.market === 'moneyline' || (o.line !== null && Number.isFinite(o.line))));
  if (!valid.length) return null;
  const table = ctx.table ?? NFL_PUSH_TABLE;
  const { regime, scores } = rank(valid, ctx.market, ctx.live, ctx.anchor, table);

  let top = 0;
  for (let i = 1; i < valid.length; i++) if (compareKeys(scores[i]!, scores[top]!) > 0) top = i;
  const winners = valid.filter((_, i) => compareKeys(scores[i]!, scores[top]!) === 0);
  // Losers best-first, so reasons cite the runner-up.
  const losers = valid
    .map((o, i) => ({ o, s: scores[i]! }))
    .filter(({ s }) => compareKeys(s, scores[top]!) !== 0)
    .sort((a, b) => compareKeys(b.s, a.s))
    .map(({ o }) => o);
  const best = winners[0]!;
  const exact = regime === 'payout';
  const rule: BestRule = regime === 'model' ? 'R3' : regime === 'line' ? 'R4' : winners.length > 1 ? 'R5' : ctx.market === 'moneyline' ? 'R1' : 'R2';

  return {
    offers: winners,
    books: winners.map((o) => o.book),
    exact,
    rule,
    reason: explain(rule, winners, losers, ctx.market, table, valid, scores),
  };
}

/** Best offer for one side of a game's market, or null when no book offers it. */
export function bestOf(game: GameOffers, market: MarketType, side: Side, opts: BestOptions = {}): BestResult | null {
  const offers: Offer[] = [];
  for (const book of Object.keys(game.books) as BookId[]) {
    const o = game.books[book]?.[market]?.[side];
    if (o) offers.push(o);
  }
  if (!offers.length) return null;
  const anchor = (opts.fair ?? getFairProbability)(game, market, opts);
  return rankOffers(offers, { market, live: game.live, anchor, table: opts.table });
}

/** Compare two offers for the same side of the same market (the anchor comes from the whole market). */
export function compareOdds(a: Offer, b: Offer, ctx: { market: MarketType; live: boolean; anchor: FairAnchor | null; table?: PushTable }): Comparison {
  const r = rankOffers([a, b], ctx);
  if (!r) return { pick: 'tie', reason: 'no valid prices', exact: true };
  const aWins = r.offers.includes(a);
  const bWins = r.offers.includes(b);
  return { pick: aWins && bWins ? 'tie' : aWins ? 'a' : 'b', reason: r.reason, exact: r.exact };
}

// ------------------------------------------------------------------------------------- reasons

const fmtAmerican = (a: number) => (a > 0 ? `+${a}` : `${a}`);
const fmtLine = (o: Offer, market: MarketType) => (o.line === null ? '' : market === 'spread' && o.line > 0 ? `+${o.line}` : `${o.line}`);
const fmtOffer = (o: Offer, market: MarketType) => `${fmtLine(o, market)} ${fmtAmerican(o.american)}`.trim();

function explain(
  rule: BestRule,
  winners: Offer[],
  losers: Offer[],
  market: MarketType,
  table: PushTable,
  all: Offer[],
  scores: number[][],
): string {
  const w = winners[0]!;
  const l = losers[0];
  if (!l && winners.length === 1) return `Only ${w.book} is offering this side`;
  switch (rule) {
    case 'R1':
      return `Highest payout: ${fmtAmerican(w.american)} vs ${fmtAmerican(l!.american)}`;
    case 'R2':
      return `Same line, better price: ${fmtOffer(w, market)} vs ${fmtOffer(l!, market)}`;
    case 'R5':
      return `Same ${market === 'moneyline' ? 'price' : 'line and price'} at ${winners.map((o) => o.book).join(' and ')}`;
    case 'R3': {
      const rw = scores[all.indexOf(w)]![0]!;
      const rl = l ? scores[all.indexOf(l)]![0]! : rw;
      const pushes = [w, l]
        .filter((o): o is Offer => !!o && o.line !== null && isInt(o.line))
        .map((o) => Math.abs(o.line!))
        .filter((k, i, a) => a.indexOf(k) === i)
        .map((k) => `${k} lands ${(table.pm(k) * 100).toFixed(1)}%`);
      const dominance = l && lineValue(w, market) > lineValue(l, market) && americanToDecimal(w.american) >= americanToDecimal(l.american) ? '; better line and price' : '';
      return `Est. return per $1: ${rw.toFixed(3)} vs ${rl.toFixed(3)}${pushes.length ? ` (${pushes.join(', ')})` : ''}${dominance}`;
    }
    case 'R4': {
      if (!l) return `Better line: ${fmtOffer(w, market)}`;
      const sameLine = w.line === l.line;
      const why =
        market === 'total' ? (w.side === 'over' ? 'Lower total for the over' : 'Higher total for the under') : 'More points for the bettor';
      const dominance = !sameLine && americanToDecimal(w.american) >= americanToDecimal(l.american) ? '; better line and price' : '';
      return sameLine ? `Same line, better price: ${fmtOffer(w, market)} vs ${fmtOffer(l, market)}` : `${why}: ${fmtOffer(w, market)} vs ${fmtOffer(l, market)}${dominance}`;
    }
  }
}
