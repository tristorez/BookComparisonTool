import type { MarketType, Side } from '@shared/domain';

/** U+2212, the typographic minus sign used for every displayed negative number. */
export const MINUS = '−';
export const ET_ZONE = 'America/New_York';

/** Absolute value with float noise removed: 7.5 → "7.5", 3 → "3". */
function magnitude(x: number): string {
  return String(Number(Math.abs(x).toFixed(2)));
}

/** American odds: `+150`, `−110`. */
export function formatAmerican(american: number): string {
  if (!Number.isFinite(american)) return '—';
  if (american > 0) return `+${magnitude(american)}`;
  if (american < 0) return `${MINUS}${magnitude(american)}`;
  return '0';
}

/** Spread for one side: `+7.5`, `−7.5`, `PK` for zero. */
export function formatSpread(line: number): string {
  if (line === 0) return 'PK';
  return `${line > 0 ? '+' : MINUS}${magnitude(line)}`;
}

/** Total for one side: `o51.5` / `u51.5`. */
export function formatTotal(line: number, side: Side): string {
  return `${side === 'under' ? 'u' : 'o'}${magnitude(line)}`;
}

/** The line part of a price, or null for moneyline (odds only). */
export function formatLine(market: MarketType, side: Side, line: number | null): string | null {
  if (market === 'moneyline' || line === null || !Number.isFinite(line)) return null;
  return market === 'spread' ? formatSpread(line) : formatTotal(line, side);
}

export interface PriceText {
  line: string | null;
  odds: string;
}

export function formatPrice(market: MarketType, side: Side, line: number | null, american: number): PriceText {
  return { line: formatLine(market, side, line), odds: formatAmerican(american) };
}

/** One string, e.g. "−3.5 −110", "o51.5 −105", "+150". */
export function priceString(market: MarketType, side: Side, line: number | null, american: number): string {
  const p = formatPrice(market, side, line, american);
  return p.line === null ? p.odds : `${p.line} ${p.odds}`;
}

/** Compact age: "4s", "2m", "3h", "2d". Negative input clamps to 0. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function dtf(locale: string | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, f);
  }
  return f;
}

function toDate(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Calendar date ("2026-10-25") of an instant in a time zone (default: the viewer's). */
function dateKeyIn(d: Date, timeZone?: string): string {
  return dtf('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Kickoff date in US Eastern, the date the books (and our game keys) file a game under. */
export function etDateKey(iso: string): string | null {
  const d = toDate(iso);
  return d ? dateKeyIn(d, ET_ZONE) : null;
}

/** "Sunday, Oct 25" for an ET date group. */
export function formatEtDateLabel(iso: string): string {
  const d = toDate(iso);
  return d ? dtf('en-US', { timeZone: ET_ZONE, weekday: 'long', month: 'short', day: 'numeric' }).format(d) : 'Date TBD';
}

export interface ZoneOptions {
  /** Viewer's zone by default; tests pin it. */
  timeZone?: string;
  locale?: string;
}

/**
 * Kickoff in the viewer's local time ("1:00 PM"). Games are grouped by their US Eastern date, so when
 * the viewer's calendar date differs (e.g. a Monday night game seen from Europe) the weekday is added.
 */
export function formatKickoff(iso: string, opts: ZoneOptions = {}): string {
  const d = toDate(iso);
  if (!d) return 'TBD';
  const time = dtf(opts.locale, { timeZone: opts.timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  if (dateKeyIn(d, opts.timeZone) === dateKeyIn(d, ET_ZONE)) return time;
  return `${dtf(opts.locale, { timeZone: opts.timeZone, weekday: 'short' }).format(d)} ${time}`;
}

/** "Steelers" from "Pittsburgh Steelers" (every NFL nickname is one word). */
export function nickname(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[parts.length - 1] ?? fullName;
}
