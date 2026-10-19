/**
 * Build src/shared/data/nfl-push-table.json: how often an NFL favorite wins by exactly k points
 * when the closing spread is near k. Best Price uses it to value the half-point between two lines
 * (Decisions.txt D-23).
 *
 *   npm run push-table
 *
 * Source: nflverse games.csv (completed games). For each k = 1..21:
 *   p_k = (hits_k + M * pooled_k) / (n_k + M)
 * where n_k = games with |closing spread| within ±1 of k, hits_k = those the favorite won by exactly k,
 * and pooled_k = the favorite-wins-by-k rate over all games (empirical-Bayes shrinkage, M = 300;
 * the tails are sparse: k >= 15 has n < 200). k = 0 is the tie rate.
 */
import { writeFileSync } from 'node:fs';

const URL_ = 'https://github.com/nflverse/nfldata/raw/master/data/games.csv';
const OUT = new URL('../src/shared/data/nfl-push-table.json', import.meta.url);
const M = 300;
const WINDOW = 1;
const MAX_K = 21;

/** Minimal RFC 4180 parser (quoted fields, escaped quotes). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const res = await fetch(URL_);
if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${URL_}`);
const [header, ...body] = parseCsv(await res.text());
if (!header) throw new Error('empty CSV');
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`games.csv has no "${name}" column`);
  return i;
};
const [iSeason, iResult, iSpread] = [col('season'), col('result'), col('spread_line')];

const games = body
  .filter((r) => r[iResult] !== '' && r[iResult] !== undefined && r[iSpread] !== '' && r[iSpread] !== undefined)
  .map((r) => ({ season: Number(r[iSeason]), result: Number(r[iResult]), spread: Number(r[iSpread]) }))
  .filter((g) => Number.isFinite(g.result) && Number.isFinite(g.spread));

// Column semantics: result = home - away; spread_line > 0 = home favored (the opposite sign of a book's
// home line). Favorites should win by more, so the two must correlate positively.
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const ms = mean(games.map((g) => g.spread));
const mr = mean(games.map((g) => g.result));
const cov = mean(games.map((g) => (g.spread - ms) * (g.result - mr)));
const sd = (xs: number[], m: number) => Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
const corr = cov / (sd(games.map((g) => g.spread), ms) * sd(games.map((g) => g.result), mr));
if (!(corr > 0.3)) throw new Error(`unexpected column semantics: corr(spread_line, result) = ${corr.toFixed(3)}`);

/** Favorite's winning margin; pick'em games count the absolute margin. */
const favMargin = (g: { result: number; spread: number }) => (g.spread > 0 ? g.result : g.spread < 0 ? -g.result : Math.abs(g.result));

const n = games.length;
const ties = games.filter((g) => g.result === 0).length;
const table = [{ k: 0, p: round((ties + 1) / (n + 2)), n, hits: ties, pooled: round(ties / n) }];
for (let k = 1; k <= MAX_K; k++) {
  const pooled = games.filter((g) => favMargin(g) === k).length / n;
  const near = games.filter((g) => Math.abs(Math.abs(g.spread) - k) <= WINDOW);
  const hits = near.filter((g) => favMargin(g) === k).length;
  table.push({ k, p: round((hits + M * pooled) / (near.length + M)), n: near.length, hits, pooled: round(pooled) });
}

const seasons = games.map((g) => g.season);
const out = {
  source: 'nflverse nfldata games.csv',
  url: URL_,
  seasons: [Math.min(...seasons), Math.max(...seasons)],
  games: n,
  correlation: round(corr),
  method: `P(favorite wins by exactly k | |closing spread| within ±${WINDOW} of k), shrunk toward the all-games rate with weight ${M}; k=0 is the tie rate`,
  shrinkageWeight: M,
  window: WINDOW,
  generatedAt: new Date().toISOString(),
  table,
};
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT.pathname}: ${n} games ${out.seasons.join('-')}, corr ${out.correlation}`);
for (const r of table.slice(0, 18)) console.log(`  k=${String(r.k).padStart(2)}  p=${r.p.toFixed(4)}  n=${r.n}`);

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
