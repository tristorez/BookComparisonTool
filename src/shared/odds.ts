/** Odds math shared by the server and the browser. */

/** American → decimal payout per $1 staked (stake included). */
export function americanToDecimal(american: number): number {
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

/** A usable displayed American price: finite, and at least 100 in magnitude. */
export function isValidAmerican(american: number): boolean {
  return Number.isFinite(american) && Math.abs(american) >= 100;
}
