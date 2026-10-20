/**
 * Many viewers at once (Decisions.txt D-24): open N SSE connections and measure board-emit → receive
 * for every delta on a sample of clients. Run from a different machine than the board (raise the fd
 * limit first: `ulimit -n 65535`), ideally against `BOOKS=fake FAKE_RATE=10`.
 *
 *   npm run load -- --url http://<host>:8080 --clients 2000 --seconds 60 [--out lags.json]
 *
 * One Node process decrypting thousands of TLS streams becomes the bottleneck itself; for big runs
 * start several processes with --out and merge the files.
 */
import { request } from 'node:http';
import { request as requestTls } from 'node:https';
import type { Delta, TimeResponse } from '../src/shared/wire.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const base = new URL(args.get('url') ?? 'http://localhost:8080');
/** Join under the base path, so a URL like https://host/prefix keeps its prefix. */
const at = (path: string) => new URL(`${base.pathname.replace(/\/$/, '')}${path}`, base);
const clients = Number(args.get('clients') ?? 500);
const seconds = Number(args.get('seconds') ?? 60);
const sampleEvery = Math.max(1, Math.floor(clients / 50)); // parse deltas on ~50 clients

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] ?? NaN;
/** No spread: a long run collects more samples than `Math.max(...xs)` can take as arguments (RangeError). */
const max = (xs: number[]) => xs.reduce((m, x) => Math.max(m, x), -Infinity);

// Clock offset from the best of 7 warm round trips (the first one pays for the TLS handshake).
let offset = 0;
let bestRtt = Infinity;
for (let i = 0; i < 7; i++) {
  const t0 = Date.now();
  const { now } = (await (await fetch(at('/api/time'))).json()) as TimeResponse;
  const t1 = Date.now();
  if (t1 - t0 < bestRtt) [bestRtt, offset] = [t1 - t0, now - (t0 + t1) / 2];
}

let open = 0;
let failed = 0;
let bytes = 0;
let deltas = 0;
const lags: number[] = [];
const sockets: { destroy(): void }[] = [];

for (let i = 0; i < clients; i++) {
  const sampled = i % sampleEvery === 0;
  const req = (base.protocol === 'https:' ? requestTls : request)(at('/api/stream'), { agent: false, headers: { accept: 'text/event-stream' } }, (res) => {
    open++;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      bytes += chunk.length;
      if (!sampled) return;
      const recvAt = Date.now() + offset;
      buf += chunk;
      let j: number;
      while ((j = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, j);
        buf = buf.slice(j + 2);
        if (!block.includes('event: delta')) continue;
        const data = block.slice(block.indexOf('data: ') + 6);
        deltas++;
        lags.push(recvAt - (JSON.parse(data) as Delta).ts);
      }
    });
    res.on('close', () => open--);
  });
  req.on('error', () => failed++);
  req.end();
  sockets.push(req);
  if (i % 200 === 199) await new Promise((r) => setTimeout(r, 50)); // ramp
}

const started = Date.now();
const timer = setInterval(() => console.log(`${((Date.now() - started) / 1000).toFixed(0)}s open=${open} failed=${failed} MB=${(bytes / 1e6).toFixed(1)}`), 5_000);
await new Promise((r) => setTimeout(r, seconds * 1_000));
clearInterval(timer);
const health = (await (await fetch(at('/api/health'))).json()) as { sse: unknown };
for (const s of sockets) s.destroy();
console.log(
  JSON.stringify(
    {
      target: base.href,
      clients,
      openAtEnd: open,
      failed,
      seconds,
      receivedMB: +(bytes / 1e6).toFixed(1),
      perClientKBps: +(bytes / 1e3 / clients / seconds).toFixed(2),
      sampledDeltas: deltas,
      emitToReceiveMs: { p50: pct(lags, 0.5), p90: pct(lags, 0.9), p99: pct(lags, 0.99), max: max(lags) },
      clockErrorMs: bestRtt / 2,
      server: health.sse,
    },
    null,
    2,
  ),
);
if (args.get('out')) (await import('node:fs')).writeFileSync(args.get('out')!, JSON.stringify(lags));
process.exit(0);
