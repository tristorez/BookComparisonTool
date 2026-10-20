/**
 * End-to-end latency from wherever this runs (e.g. a machine in Canada, like the reviewers):
 * book → board box → this client, per book × phase × first channel × first feed (Decisions.txt D-04).
 *
 *   npm run measure -- --url https://18-227-249-43.sslip.io --minutes 30 --label mnf --vantage "Toronto, ON"
 *   npm run measure -- --url https://... --smoke        # SSE edge checks (Phase 5)
 *
 * Clock: the min-round-trip sample of /api/time gives server − client offset ± RTT/2 (reported).
 * FanDuel's book timestamps are whole seconds, so its book→client values are upper bounds: the true
 * value lies in (raw − 1 s, raw]. Writes docs/latency/<date>-<label>.md, plus <date>-<label>.metrics.jsonl
 * (the board's /api/metrics every 15 min: its series keep only recent samples, so a long run snapshots them).
 * A dropped stream reconnects, so a deploy or a network blip doesn't end a long run early.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { connect as h2connect } from 'node:http2';
import type { Delta, TimeResponse } from '../src/shared/wire.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith('--')) args.set(a.slice(2), process.argv[i + 1]?.startsWith('--') || i + 1 >= process.argv.length ? 'true' : process.argv[++i]!);
}
const base = (args.get('url') ?? 'http://localhost:8080').replace(/\/$/, '');
const minutes = Number(args.get('minutes') ?? 5);
const label = args.get('label') ?? 'run';
const vantage = args.get('vantage') ?? 'unspecified';
const smoke = args.has('smoke');

type Series = Map<string, number[]>;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
};
const max = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), -Infinity); // no spread: runs collect 100k+ samples
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function clockOffset(samples = 7): Promise<{ offset: number; err: number }> {
  let best = { offset: 0, err: Infinity };
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const { now } = (await (await fetch(`${base}/api/time`)).json()) as TimeResponse;
    const t1 = Date.now();
    if ((t1 - t0) / 2 < best.err) best = { offset: now - (t0 + t1) / 2, err: (t1 - t0) / 2 };
  }
  return best;
}

interface StreamEvent {
  event: string;
  data: string;
  at: number;
}

async function stream(ms: number, onEvent: (e: StreamEvent) => void): Promise<{ ttfbMs: number }> {
  const ac = new AbortController();
  const t0 = Date.now();
  const res = await fetch(`${base}/api/stream`, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
  const ttfbMs = Date.now() - t0;
  const timer = setTimeout(() => ac.abort(), ms);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const at = Date.now();
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = '';
        let data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data = line.slice(6);
        }
        if (event) onEvent({ event, data, at });
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  } finally {
    clearTimeout(timer);
  }
  return { ttfbMs };
}

function table(series: Series, title: string, note = ''): string {
  const rows = [...series.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return `### ${title}\n\n_No samples._\n`;
  const lines = rows.map(([k, xs]) => `| ${k.split('|').join(' | ')} | ${xs.length} | ${pct(xs, 0.5).toFixed(0)} | ${pct(xs, 0.9).toFixed(0)} | ${pct(xs, 0.99).toFixed(0)} | ${max(xs).toFixed(0)} |`);
  return `### ${title}\n\n${note ? `${note}\n\n` : ''}| book | phase | channel | first feed | n | p50 ms | p90 ms | p99 ms | max ms |\n|---|---|---|---|---|---|---|---|---|\n${lines.join('\n')}\n`;
}

async function runSmoke(): Promise<void> {
  const results: string[] = [];
  const check = (name: string, ok: boolean, detail: string) => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
  const health = await fetch(`${base}/healthz`);
  check('(f) /healthz is process liveness', health.status === 200, `HTTP ${health.status}`);
  const { offset, err } = await clockOffset();
  const lags: number[] = [];
  let hbGapMax = 0;
  let lastHb = 0;
  const { ttfbMs } = await stream(Math.max(20_000, minutes * 60_000), (e) => {
    if (e.event === 'delta') lags.push(e.at + offset - (JSON.parse(e.data) as Delta).ts);
    if (e.event === 'hb') {
      if (lastHb) hbGapMax = Math.max(hbGapMax, e.at - lastHb);
      lastHb = e.at;
    }
  });
  check('(a) first byte of the stream', ttfbMs < 200, `${ttfbMs} ms`);
  check('(b) deltas arrive unbuffered (emit → receive)', lags.length > 0 && pct(lags, 0.99) < 250, `n=${lags.length} p50 ${pct(lags, 0.5).toFixed(0)} p99 ${pct(lags, 0.99).toFixed(0)} ms (clock ±${err.toFixed(0)} ms)`);
  check('(c) idle stream stays up (heartbeat gaps)', hbGapMax > 0 && hbGapMax < 12_000, `max heartbeat gap ${hbGapMax} ms over ${Math.max(20, minutes * 60)} s`);
  if (base.startsWith('https://')) {
    const alpn = await new Promise<string>((resolve) => {
      const s = h2connect(base);
      s.on('connect', () => {
        resolve(s.alpnProtocol ?? 'none');
        s.close();
      });
      s.on('error', (e) => resolve(`error: ${e.message}`));
    });
    check('(d) HTTP/2 to browsers', alpn === 'h2', `ALPN ${alpn}`);
  }
  results.push('MANUAL (e) restart → new boot id → clients get a snapshot: `sudo systemctl restart odds-board`, watch a tab.');
  console.log(results.join('\n'));
}

interface MetricsSeries {
  metric: string;
  book?: string;
  phase?: string;
  channel?: string;
  feed?: string;
  n: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}
interface Metrics {
  latency: { firstCopies: Record<string, number>; series: MetricsSeries[] };
  board: Record<string, number>;
}

function serverTable(m: Metrics | null): string {
  if (!m) return '_Could not read /api/metrics at the end of the run._\n';
  const rows = m.latency.series.map((x) => `| ${x.metric} | ${x.book ?? ''} | ${x.phase ?? ''} | ${x.channel ?? ''} | ${x.feed ?? ''} | ${x.n} | ${x.p50} | ${x.p90} | ${x.p99} | ${x.max} |`);
  return [
    '| metric | book | phase | channel | feed | n | p50 ms | p90 ms | p99 ms | max ms |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `First copies by feed: ${JSON.stringify(m.latency.firstCopies)}. Board counters: ${JSON.stringify(m.board)}.`,
    '',
  ].join('\n');
}

async function runMeasure(): Promise<void> {
  const { offset, err } = await clockOffset();
  const s2c: Series = new Map();
  const b2c: Series = new Map();
  const rx2c: Series = new Map();
  let deltas = 0;
  let snapshotBytes = 0;
  const bytes: number[] = [];
  const date = new Date().toISOString().slice(0, 10);
  mkdirSync('docs/latency', { recursive: true });
  const out = `docs/latency/${date}-${label}.md`;
  const metricsLog = `docs/latency/${date}-${label}.metrics.jsonl`;
  const readMetrics = async (): Promise<Metrics | null> => {
    try {
      const m = (await (await fetch(`${base}/api/metrics`)).json()) as Metrics;
      appendFileSync(metricsLog, `${JSON.stringify({ at: new Date().toISOString(), ...m })}\n`);
      return m;
    } catch {
      return null;
    }
  };
  console.log(`measuring ${base} for ${minutes} min from "${vantage}" (clock offset ${offset.toFixed(1)} ± ${err.toFixed(1)} ms)`);
  const push = (s: Series, k: string, v: number) => (s.get(k) ?? s.set(k, []).get(k)!).push(v);
  const onEvent = (e: StreamEvent) => {
    if (e.event === 'snapshot') snapshotBytes = e.data.length;
    if (e.event !== 'delta') return;
    deltas++;
    bytes.push(e.data.length);
    const d = JSON.parse(e.data) as Delta;
    const now = e.at + offset;
    for (const q of d.quotes ?? []) {
      if (!q.prev || q.prev.at < d.ts - 5_000) continue; // only fresh price/line moves
      const k = `${q.book}|${q.live ? 'live' : 'pre'}|${q.ch}|${q.feed}`;
      push(s2c, k, now - d.ts);
      push(rx2c, k, now - q.rx);
      if (q.bt !== null) push(b2c, k, now - q.bt);
    }
  };
  const deadline = Date.now() + minutes * 60_000;
  const metricsTimer = setInterval(() => void readMetrics(), 15 * 60_000);
  let connects = 0;
  while (Date.now() < deadline) {
    connects++;
    try {
      await stream(deadline - Date.now(), onEvent);
    } catch (e) {
      console.log(`${new Date().toISOString()} stream failed (${e instanceof Error ? e.message : String(e)}); reconnecting`);
    }
    if (Date.now() < deadline - 2_000) await sleep(2_000);
  }
  clearInterval(metricsTimer);
  const metrics = await readMetrics();
  const md = [
    `# Latency run: ${label} (${new Date().toISOString()})`,
    '',
    `- Target: ${base}`,
    `- Vantage point: ${vantage}`,
    `- Duration: ${minutes} min; ${connects} stream connection(s); ${deltas} deltas; snapshot ${snapshotBytes} B; delta p50 ${pct(bytes, 0.5)} B, p99 ${pct(bytes, 0.99)} B`,
    `- Clock: server − client offset ${offset.toFixed(1)} ms, error ±${err.toFixed(1)} ms (half the best /api/time round trip). Every client-side number carries this error.`,
    '',
    table(b2c, 'Book → this client (the age of the number on screen when it arrives)', 'FanDuel rows are upper bounds: its book timestamps are whole seconds, so the true value lies in (raw − 1000 ms, raw]. DraftKings timestamps are exact (ms).'),
    table(rx2c, 'First receipt on a feed box → this client', 'Board processing + fan-out + network to this vantage point.'),
    table(s2c, 'Board emit → this client', 'Network + TLS edge only.'),
    '### Server-side series (`/api/metrics` at the end of the run; includes real-browser beacons)',
    '',
    `Each series holds its most recent 5,000 samples; \`${metricsLog.split('/').at(-1)}\` has a snapshot every 15 min.`,
    '',
    serverTable(metrics),
  ].join('\n');
  writeFileSync(out, md);
  console.log(md.split('### Server-side')[0]);
  console.log(`wrote ${out}`);
}

if (smoke) await runSmoke();
else await runMeasure();
