import type { MarketType, Side } from '@shared/domain';

/** Decimal payout per $1 staked, derived from the displayed American price. */
export function americanToDecimal(american: number): number {
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

export interface PricePoint {
  line: number | null;
  american: number;
}

/**
 * Is `to` better for the bettor than `from`? Returns 1 (better), -1 (worse) or 0 (same terms).
 *
 * A line change decides on its own: more points taken / fewer laid on a spread, a lower total for an
 * over, a higher total for an under. With the same line, the higher payout wins (compared as decimal,
 * so +100 and −100 are equal).
 */
export function compareForBettor(market: MarketType, side: Side, from: PricePoint, to: PricePoint): -1 | 0 | 1 {
  if (market !== 'moneyline' && from.line !== null && to.line !== null && from.line !== to.line) {
    const better = side === 'over' ? to.line < from.line : side === 'under' ? to.line > from.line : to.line > from.line;
    return better ? 1 : -1;
  }
  const a = americanToDecimal(from.american);
  const b = americanToDecimal(to.american);
  if (Math.abs(a - b) < 1e-9) return 0;
  return b > a ? 1 : -1;
}
