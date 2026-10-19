#!/usr/bin/env node
/**
 * Egress check: can this machine reach DraftKings and FanDuel the way the connectors do?
 * Zero dependencies (Node >= 18), so it can be copied to any box and run as-is:
 *
 *   node probe-egress.mjs [--state nj] [--seconds 10]
 *
 * --state takes a US state (nj, pa, …) or a Canadian province FanDuel serves (on, ab). Canadian
 * regions use the `.ca` FanDuel hosts and DK's `dkca…` / `sportsbook-ws-ca-…` names.
 *
 * Checks DK REST snapshot, DK socket (upgrade + subscribe ack), FD board, FD SMP prices and
 * FD PIR push (upgrade + connection_ack), then prints a verdict for running from this host.
 */
import https from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';

if (typeof fetch !== 'function') {
  console.error('Node 18 or newer is required (global fetch).');
  process.exit(1);
}

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const STATE = arg('state', 'nj').toLowerCase();
const CA = ['on', 'ab'].includes(STATE);
const FD_DOMAIN = CA ? 'fanduel.ca' : 'fanduel.com';
const DK_SITE = CA ? `dkca${STATE}` : `dkus${STATE}`;
const DK_WS_HOST = CA ? `sportsbook-ws-ca-${STATE}` : `sportsbook-ws-us-${STATE}`;
const SECONDS = Number(arg('seconds', '10'));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FD_APP_KEY = 'FhMFpcPWXMeyZxOx';
const FD_PIR_KEY = 'NfxZUKb5R+do8pGKXq27wPTO3JHUlUmn';
const FD_GAME_LINES = new Set(['MONEY_LINE', 'MATCH_HANDICAP_(2-WAY)', 'TOTAL_POINTS_(OVER/UNDER)']);

const ok = (detail) => ({ ok: true, detail });
const fail = (detail) => ({ ok: false, detail });
const akamaiRef = (body = '') => {
  const m = body.match(/Reference&#32;&#35;([0-9a-f&#;.]+)/i) ?? body.match(/Reference #([0-9a-f.]+)/i);
  return m ? ` · Akamai ref ${m[1].replace(/&#46;/g, '.')}` : '';
};

async function getJson(url, init = {}) {
  const started = Date.now();
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const body = await res.text();
  const ms = Date.now() - started;
  let data = null;
  try {
    data = JSON.parse(body);
  } catch {}
  return { res, body, data, ms };
}

/** Minimal RFC 6455 client: enough to check an upgrade and exchange text frames. */
function wsConnect(url, { headers = {}, protocol } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(protocol ? { 'Sec-WebSocket-Protocol': protocol } : {}),
        'User-Agent': UA,
        ...headers,
      },
      timeout: 10_000,
    });
    req.on('timeout', () => req.destroy(new Error('upgrade timed out')));
    req.on('error', reject);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, server: res.headers.server, body }));
    });
    req.on('upgrade', (res, socket, head) => {
      const listeners = [];
      let buf = head ?? Buffer.alloc(0);
      let fragments = [];
      const write = (opcode, payload) => {
        const len = payload.length;
        const header =
          len < 126
            ? Buffer.from([0x80 | opcode, 0x80 | len])
            : len < 65_536
              ? Buffer.from([0x80 | opcode, 0x80 | 126, len >> 8, len & 255])
              : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
        const mask = randomBytes(4);
        const body = Buffer.alloc(len);
        for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
        socket.write(Buffer.concat([header, mask, body]));
      };
      const drain = () => {
        while (buf.length >= 2) {
          const fin = (buf[0] & 0x80) !== 0;
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            off = 10;
          }
          if (buf.length < off + len) return;
          const payload = buf.subarray(off, off + len);
          buf = buf.subarray(off + len);
          if (opcode === 0x1 || opcode === 0x0) {
            fragments.push(payload);
            if (fin) {
              const text = Buffer.concat(fragments).toString('utf8');
              fragments = [];
              listeners.forEach((fn) => fn(text));
            }
          } else if (opcode === 0x9) write(0xa, payload); // ping → pong
        }
      };
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        drain();
      });
      socket.on('error', () => {});
      resolve({
        status: res.statusCode,
        send: (text) => write(0x1, Buffer.from(text)),
        onText: (fn) => {
          listeners.push(fn);
          drain();
        },
        close: () => {
          write(0x8, Buffer.from([0x03, 0xe8]));
          socket.end();
        },
      });
    });
    req.end();
  });
}

async function egress() {
  try {
    const { data } = await getJson('https://ipinfo.io/json', { headers: { 'User-Agent': UA } });
    return data ? `${data.ip} · ${data.org ?? '?'} · ${[data.city, data.region, data.country].filter(Boolean).join(', ')}` : 'unknown';
  } catch {
    return 'unknown (ipinfo.io unreachable)';
  }
}

const DK_REST_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Origin: 'https://sportsbook.draftkings.com',
  Referer: 'https://sportsbook.draftkings.com/',
};
const dkRestUrl = (site) => `https://sportsbook-nash.draftkings.com/api/sportscontent/${site}/v1/leagues/88808/categories/492/subcategories/4518`;
const priceSignature = (data) =>
  (data.selections ?? []).map((s) => `${s.marketId}|${s.label}|${s.points ?? ''}|${s.displayOdds?.american}`).sort().join(';');

async function dkRest() {
  const { res, body, data, ms } = await getJson(dkRestUrl(DK_SITE), { headers: DK_REST_HEADERS });
  if (!res.ok) return fail(`HTTP ${res.status} (${res.headers.get('server') ?? '?'})${akamaiRef(body)}`);
  if (!data) return fail(`HTTP 200 but not JSON (bot challenge?): ${body.slice(0, 80).replace(/\s+/g, ' ')}`);
  // Control: DK ignores the site name (README DK-17), so a status code alone proves reachability, not the region.
  let control = '';
  try {
    const c = await getJson(dkRestUrl('zz'), { headers: DK_REST_HEADERS });
    control = c.data
      ? priceSignature(c.data) === priceSignature(data)
        ? ' · same prices as bogus site "zz": site name ignored, region NOT verified'
        : ' · differs from bogus site "zz": site name is honoured'
      : ` · bogus site "zz" → HTTP ${c.res.status}: site name is validated`;
  } catch {}
  return ok(`200 · ${data.events?.length ?? 0} events · ${data.selections?.length ?? 0} selections · ${ms} ms${control}`);
}

async function dkSocket() {
  const started = Date.now();
  const conn = await wsConnect(`wss://${DK_WS_HOST}.draftkings.com/websocket?format=json&locale=en`, {
    headers: { Origin: 'https://sportsbook.draftkings.com', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (conn.status !== 101) return fail(`upgrade HTTP ${conn.status} (${conn.server ?? '?'})${akamaiRef(conn.body)}`);
  const upgradeMs = Date.now() - started;
  return new Promise((resolve) => {
    let ackMs = null;
    let updates = 0;
    let other = null;
    conn.onText((text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.event === 'subscribed') ackMs ??= Date.now() - started;
      else if (msg.event === 'update') updates++;
      else other ??= text.slice(0, 120);
    });
    conn.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        id: randomUUID(),
        params: {
          entity: 'events',
          queryParams: {
            query: "$filter=leagueId eq '88808' and clientMetadata/Subcategories/any(s: s/Id eq '4518')&$orderBy=startEventDate asc",
            includeMarkets: "$filter=tags/all(t: t ne 'SportcastBetBuilder') and clientMetadata/subCategoryId eq '4518'",
            initialData: false,
            projection: 'sportsbook',
            locale: 'en',
          },
          forwardedHeaders: {},
          clientMetadata: { feature: 'league', 'X-Client-Name': 'web', 'X-Client-Version': '2640.4.1.8' },
          jwt: 'default-token',
          siteName: DK_SITE,
        },
      }),
    );
    setTimeout(() => {
      conn.close();
      resolve(
        ackMs !== null
          ? ok(`101 in ${upgradeMs} ms · subscribed in ${ackMs} ms · ${updates} updates in ${SECONDS}s`)
          : fail(`101 but no subscribe ack in ${SECONDS}s${other ? ` · got: ${other}` : ''}`),
      );
    }, SECONDS * 1000);
  });
}

/** FD board → market ids, then SMP prices and PIR push against those ids. */
async function fanduel() {
  const tz = encodeURIComponent('America/New_York');
  const headers = { 'User-Agent': UA, Accept: 'application/json', Origin: `https://sportsbook.${FD_DOMAIN}`, Referer: `https://sportsbook.${FD_DOMAIN}/` };
  const out = { board: null, smp: null, pir: null };

  const board = await getJson(
    `https://sbapi.${STATE}.sportsbook.${FD_DOMAIN}/api/content-managed-page?page=CUSTOM&customPageId=nfl&pbHorizontal=false&timezone=${tz}&_ak=${FD_APP_KEY}`,
    { headers },
  );
  if (!board.res.ok || !board.data?.attachments) {
    out.board = fail(`HTTP ${board.res.status} (${board.res.headers.get('server') ?? '?'})`);
    out.smp = out.pir = fail('skipped (no board)');
    return out;
  }
  const markets = Object.values(board.data.attachments.markets ?? {}).filter((m) => FD_GAME_LINES.has(m.marketType));
  const ids = markets.map((m) => m.marketId).slice(0, 70);
  out.board = ok(`200 · ${new Set(markets.map((m) => m.eventId)).size} games · ${markets.length} main markets · ${board.ms} ms`);

  const smp = await getJson(`https://smp.${STATE}.sportsbook.${FD_DOMAIN}/api/sports/fixedodds/readonly/v1/getMarketPrices?priceHistory=0`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketIds: ids }),
  });
  out.smp = smp.res.ok && Array.isArray(smp.data) ? ok(`200 · ${smp.data.length} markets priced · ${smp.ms} ms`) : fail(`HTTP ${smp.res.status} (${smp.res.headers.get('server') ?? '?'})`);

  const host = `pir.${STATE}.sportsbook.${FD_DOMAIN}`;
  const auth = { Authorization: FD_PIR_KEY, host };
  const b64 = (o) => encodeURIComponent(Buffer.from(JSON.stringify(o)).toString('base64'));
  const started = Date.now();
  const conn = await wsConnect(`wss://${host}/graphql/realtime?header=${b64(auth)}&payload=${b64({})}`, {
    headers: { Origin: `https://sportsbook.${FD_DOMAIN}` },
    protocol: 'graphql-ws',
  });
  if (conn.status !== 101) {
    out.pir = fail(`upgrade HTTP ${conn.status} (${conn.server ?? '?'})`);
    return out;
  }
  out.pir = await new Promise((resolve) => {
    let ackMs = null;
    let startAck = false;
    let frames = 0;
    conn.onText((text) => {
      const msg = JSON.parse(text);
      if (msg.type === 'connection_ack') {
        ackMs = Date.now() - started;
        conn.send(
          JSON.stringify({
            id: randomUUID(),
            type: 'start',
            payload: {
              data: JSON.stringify({
                query: 'subscription OnUpdateMarketPrice($ids: [String!]!) { onUpdateMarketPrice(ids: $ids) { marketId marketStatus updatedAt } }',
                variables: { ids },
              }),
              extensions: { authorization: auth },
            },
          }),
        );
      } else if (msg.type === 'start_ack') startAck = true;
      else if (msg.type === 'data') frames++;
    });
    conn.send(JSON.stringify({ type: 'connection_init' }));
    setTimeout(() => {
      conn.close();
      resolve(
        ackMs !== null && startAck
          ? ok(`101 · connection_ack in ${ackMs} ms · subscribed to ${ids.length} markets · ${frames} price frames in ${SECONDS}s`)
          : fail(`101 but ${ackMs === null ? 'no connection_ack' : 'subscription not acknowledged'}`),
      );
    }, SECONDS * 1000);
  });
  return out;
}

const settle = (p) => p.catch((err) => fail(err?.message ?? String(err)));
console.log(`Probing from this host for ${SECONDS}s (state ${STATE.toUpperCase()}, Node ${process.version}) …`);
const [where, dkR, dkW, fd] = await Promise.all([
  egress(),
  settle(dkRest()),
  settle(dkSocket()),
  fanduel().catch((err) => ({ board: fail(err.message), smp: fail('skipped'), pir: fail('skipped') })),
]);

const rows = [
  ['DraftKings', 'REST snapshot', dkR],
  ['DraftKings', 'WebSocket', dkW],
  ['FanDuel', 'board (discovery)', fd.board],
  ['FanDuel', 'SMP prices', fd.smp],
  ['FanDuel', 'PIR push', fd.pir],
];
console.log(`\nEgress: ${where}\n`);
for (const [book, check, r] of rows) console.log(`${book.padEnd(11)} ${check.padEnd(18)} ${r.ok ? 'OK  ' : 'FAIL'}  ${r.detail}`);

const dk =
  dkR.ok && dkW.ok
    ? 'DraftKings: OK to run directly from this host.'
    : !dkR.ok && dkW.ok
      ? 'DraftKings: socket OK, REST blocked → run here and proxy only the snapshot calls (DK_REST_PROXY_URL).'
      : dkR.ok && !dkW.ok
        ? 'DraftKings: REST OK, socket blocked → proxy the socket (DK_WS_PROXY_URL).'
        : 'DraftKings: blocked from this IP → needs another host or a US residential/ISP proxy (DK_PROXY_URL).';
const fdOk = fd.board.ok && fd.smp.ok && fd.pir.ok;
console.log('\nNote: the DraftKings rows prove reachability only; DK ignores the site name, so they do not show a region.');
console.log(`\n${dk}\nFanDuel: ${fdOk ? 'OK to run directly from this host.' : 'not fully reachable (see rows above).'}`);
process.exit(dkR.ok && dkW.ok && fdOk ? 0 : dkW.ok && fdOk ? 2 : 1);
