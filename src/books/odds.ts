/**
 * Parse an American price as books render it: "+150", "-110", DK's U+2212 minus ("−110"), "EVEN".
 * Returns null for anything that is not a usable price.
 */
export function parseAmerican(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw !== 0 ? Math.round(raw) : null;
  const s = raw.trim().replace(/[−‒–—]/g, '-');
  if (/^even$/i.test(s)) return 100;
  const n = Number(s);
  return Number.isFinite(n) && n !== 0 ? Math.round(n) : null;
}

/** Null for anything that is not a real price (decimal ≤ 1 would otherwise give ±Infinity). */
export function decimalToAmerican(decimal: number): number | null {
  if (!Number.isFinite(decimal) || decimal <= 1) return null;
  if (decimal >= 2) return Math.round((decimal - 1) * 100);
  return Math.round(-100 / (decimal - 1));
}
