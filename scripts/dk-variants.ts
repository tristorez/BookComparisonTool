/**
 * Is there a faster way to subscribe to DraftKings' in-play prices than the one we use?
 *
 * Opens several sockets at once from the same machine, each with a different subscription, and times the
 * same price change on each. DK's delay is mostly inside DK (engine → publish, README "Latency"), so the
 * question is whether any subscription shape is served from a quicker path. Everything is measured
 * relative to the other variants, on one clock, so book-clock offset and our network cancel out.
 *
 *   npx tsx scripts/dk-variants.ts [--seconds 600] [--state nj] [--extra '<json>']
 *
 * Needs an egress IP DraftKings accepts (AWS us-east-2; the St. Louis dev server is blocked), and a game in
 * play for any variance to show. Run `node scripts/probe-egress.mjs` first. One REST read plus one socket per
 * variant: about as much as three browser tabs.
 *
 * A price state is `selectionId|american|points`. For each state seen on ≥ 2 variants:
 *   lag      = this variant's receive time − the earliest receive time on any variant ("first" if it was the earliest)
 *   book→us  = receive − createdTime          (what the board uses)
 *   engine→publish = publishedTime − createdTime, gateway→us = receive − websocketPublishTimestamp
 * If a variant has a lower engine→publish for the same createdTime, DK is publishing that subscription through
 * a faster pipeline; if only the lag differs, it is just the network or gateway.
 *
 * `--extra` adds variants: '[{"name":"x","entity":"events","query":"$filter=…","includeMarkets":"$filter=…"}]'.
 */
import WebSocket from 'ws';
import { BROWSER_UA, createDispatcher, createWsAgent, requestJson } from '../src/books/http.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? 'true');
const seconds = Number(args.get('seconds') ?? 600);
const state = args.get('state') ?? 'nj';
const site = `dkus${state}`;
const LEAGUE = '88808';
const SUB = '4518';
const restUrl = `https://sportsbook-nash.draftkings.com/api/sportscontent/${site}/v1/leagues/${LEAGUE}/categories/492/subcategories/${SUB}`;
const wsUrl = `wss://sportsbook-ws-us-${state}.draftkings.com/websocket?format=json&locale=en`;

interface Variant { name: string; entity?: string; query: string; includeMarkets?: string }

const baseQuery = `$filter=leagueId eq '${LEAGUE}' and clientMetadata/Subcategories/any(s: s/Id eq '${SUB}')&$orderBy=startEventDate asc`;
const baseMarkets = `$filter=tags/all(t: t ne 'SportcastBetBuilder') and clientMetadata/subCategoryId eq '${SUB}'`;

interface Rx { rx: number; created: number | null; published: number | null; gateway: number | null }
const seen = new Map<string, Map<string, Rx>>(); // variant → state → first receipt
const frames = new Map<string, number>();
const errors = new Map<string, string>();

const parseTime = (v: unknown): number | null => {
  const t = typeof v === 'string' || typeof v === 'number' ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? NaN;

async function discoverLiveEvent(): Promise<{ id: string; name: string } | null> {
  const res = await requestJson<{ events?: { id: string; name?: string; status?: string }[] }>(restUrl, {
    dispatcher: createDispatcher(),
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://sportsbook.draftkings.com', Referer: 'https://sportsbook.draftkings.com/' },
  });
  const live = res.data.events?.find((e) => e.status === 'STARTED');
  return live ? { id: live.id, name: live.name ?? live.id } : null;
}

function open(v: Variant): void {
  seen.set(v.name, new Map());
  frames.set(v.name, 0);
  const ws = new WebSocket(wsUrl, {
    headers: { Origin: 'https://sportsbook.draftkings.com', 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
    agent: createWsAgent(undefined),
    handshakeTimeout: 10_000,
  });
  ws.on('open', () =>
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        id: `v-${v.name}`,
        params: {
          entity: v.entity ?? 'events',
          queryParams: { query: v.query, includeMarkets: v.includeMarkets, initialData: false, projection: 'sportsbook', locale: 'en' },
          forwardedHeaders: {},
          clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': '2640.4.1.8' },
          jwt: 'default-token',
          siteName: site,
        },
      }),
    ),
  );
  ws.on('message', (raw) => {
    const rx = Date.now();
    let f: any;
    try { f = JSON.parse(raw.toString()); } catch { return; }
    if (f.error) errors.set(v.name, JSON.stringify(f.error).slice(0, 200));
    const body = f?.data;
    if (!body || typeof body !== 'object' || !body.data) return;
    frames.set(v.name, frames.get(v.name)! + 1);
    const meta = { rx, created: parseTime(body.metadata?.createdTime), published: parseTime(body.metadata?.publishedTime), gateway: parseTime(f.websocketPublishTimestamp) };
    for (const list of [body.data.add?.selections, body.data.change?.selections] as any[][]) {
      for (const s of list ?? []) {
        const american = s?.displayOdds?.american;
        if (american === undefined) continue;
        const key = `${s.id}|${american}|${s.points ?? ''}`;
        if (!seen.get(v.name)!.has(key)) seen.get(v.name)!.set(key, meta);
      }
    }
  });
  ws.on('unexpected-response', (_q, res) => errors.set(v.name, `upgrade refused: HTTP ${res.statusCode}`));
  ws.on('error', (e) => errors.set(v.name, e.message));
  ws.on('close', (code) => { if (!errors.has(v.name)) errors.set(v.name, `closed ${code}`); });
  setTimeout(() => ws.close(), seconds * 1000);
}

const live = await discoverLiveEvent().catch((e) => { console.error(`REST snapshot failed: ${e.message}`); return null; });
const variants: Variant[] = [
  { name: 'base', query: baseQuery, includeMarkets: baseMarkets },
  { name: 'base-2 (control)', query: baseQuery, includeMarkets: baseMarkets }, // same subscription twice: the noise floor
  { name: 'live-only', query: `$filter=leagueId eq '${LEAGUE}' and status eq 'STARTED' and clientMetadata/Subcategories/any(s: s/Id eq '${SUB}')`, includeMarkets: baseMarkets },
  { name: 'all-markets', query: baseQuery }, // no includeMarkets filter
];
if (live) variants.push({ name: 'one-event', query: `$filter=id eq '${live.id}'`, includeMarkets: baseMarkets });
for (const x of JSON.parse(args.get('extra') ?? '[]') as Variant[]) variants.push(x);

console.log(`${variants.length} variants on ${wsUrl} for ${seconds} s${live ? ` (live event: ${live.name})` : ' (no game in play: expect little variance)'}`);
variants.forEach(open);
await new Promise((r) => setTimeout(r, seconds * 1000 + 1500));

const names = variants.map((v) => v.name);
const all = new Set<string>();
for (const m of seen.values()) for (const k of m.keys()) all.add(k);
const lagBy = new Map<string, number[]>();
const firstBy = new Map<string, number>();
let shared = 0;
for (const k of all) {
  const got = names.filter((n) => seen.get(n)!.has(k));
  if (got.length < 2) continue;
  shared++;
  const earliest = Math.min(...got.map((n) => seen.get(n)!.get(k)!.rx));
  for (const n of got) {
    const lag = seen.get(n)!.get(k)!.rx - earliest;
    (lagBy.get(n) ?? lagBy.set(n, []).get(n)!).push(lag);
    if (lag === 0) firstBy.set(n, (firstBy.get(n) ?? 0) + 1);
  }
}

console.log(`\n${all.size} distinct price states, ${shared} seen on ≥ 2 variants\n`);
console.log(`${'variant'.padEnd(18)}${'frames'.padStart(8)}${'states'.padStart(8)}${'first'.padStart(8)}${'lag p50'.padStart(9)}${'p90'.padStart(7)}${'p99'.padStart(7)}${'book→us p50'.padStart(13)}${'eng→pub p50'.padStart(13)}${'gw→us p50'.padStart(11)}`);
for (const n of names) {
  const rows = [...seen.get(n)!.values()];
  const lag = lagBy.get(n) ?? [];
  const col = (f: (r: Rx) => number | null) => pct(rows.map(f).filter((x): x is number => x !== null), 0.5);
  console.log(
    `${n.padEnd(18)}${String(frames.get(n)).padStart(8)}${String(rows.length).padStart(8)}${String(firstBy.get(n) ?? 0).padStart(8)}` +
      `${String(pct(lag, 0.5)).padStart(9)}${String(pct(lag, 0.9)).padStart(7)}${String(pct(lag, 0.99)).padStart(7)}` +
      `${String(col((r) => (r.created === null ? null : r.rx - r.created))).padStart(13)}${String(col((r) => (r.created === null || r.published === null ? null : r.published - r.created))).padStart(13)}${String(col((r) => (r.gateway === null ? null : r.rx - r.gateway))).padStart(11)}`,
  );
}
if (errors.size) console.log(`\nproblems:\n${[...errors].map(([n, e]) => `  ${n}: ${e}`).join('\n')}`);
console.log('\nRead it like this: the two "base" rows are the noise floor. A variant is only faster if its lag p50 and its');
console.log('book→us p50 beat that floor by more than the base-vs-base-2 gap, over many states.');
