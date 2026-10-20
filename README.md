# Betstamp take-home: real-time NFL odds, DraftKings vs FanDuel

A live best-price board for NFL moneyline, spread and total (pregame and in-play) from DraftKings and
FanDuel, normalized into one model and pushed to the browser as lines move.

- **Live:** https://18-227-249-43.sslip.io
- **Code:** https://github.com/tristorez/OddsComparisonTool

The board has a Best Price / DraftKings / FanDuel toggle, flashes prices that just changed, shows each
book's freshness, and says so when a book's data is stale.

---

## 1. Run it locally

```bash
nvm use                      # Node 24.22.0 (.nvmrc); engine-strict is on
npm ci
npm run dev                  # board server (:8080, real books) + Vite UI (:5173)
BOOKS=fake npm run dev       # synthetic books: no network, works anywhere
VITE_API_TARGET=https://18-227-249-43.sslip.io npm run dev:remote   # local UI against the live server
npm test                     # best price, merge, board, SSE + feed link, UI
npm run build && npm start   # production: one Node process serves the API, the stream and the site
```

Settings are environment variables (`src/server/config.ts`, [`.env.example`](.env.example)). The
connectors also run alone: `npm run watch:fd`, `npm run watch:dk`, `npm run watch`.

**Where you run it matters.** DraftKings' Akamai edge blocks many datacenter IPs (our dev VPS included).
`node scripts/probe-egress.mjs` reports which channels a machine can reach. If DK is blocked, use
`npm run dev:remote` or `BOOKS=fake`.

## 2. Architecture

```
  DraftKings  REST snapshot + JSON-RPC socket ──▶ ┌─ feed (one connector per book) ───────────┐
  FanDuel     board page, 1 s SMP poll, PIR push ─▶│ normalize → Quote {book, game, market,     │
                                                   │ side, line, odds}; diff; health; samples   │
                                                   └───────────────┬────────────────────────────┘
                                         same process (box A) / TCP link (box B)
                                                   ┌───────────────▼────────────────────────────┐
                                                   │ board: merge feeds (first copy wins) →      │
                                                   │ best price → staleness → SSE hub            │──▶ browsers
                                                   └────────────────────────────────────────────┘
```

- **One ingestion per book, not per tab.** Connectors own their connections and emit normalized
  changes. Fan-out happens after normalization: each delta is serialized once and sent to every viewer.
- **A third book is a new translator, not a re-architecture.** `BookConnector` (`src/books/types.ts`)
  handles state, diffing, status and samples; a connector only maps its feed into games and quotes.
- **Deployment:** AWS `us-east-2`, two feed boxes on separate IPs (A also runs the board and the site, B
  is feed-only), Caddy for TLS and HTTP/2. FanDuel's push origin is 1–5 ms away from there.
- **Matching:** games are keyed `YYYY-MM-DD(ET):AWAY@HOME` (books disagree on kickoff by a minute); teams
  resolve by nickname (FD "Washington Commanders", DK "WAS Commanders"); sides come from each book's own
  result type, not names.
- **Best price on different lines:** same line, higher payout wins. For pregame spreads on different
  lines (e.g. −3 −110 vs −3.5 +100) each offer is scored by estimated return, using a no-vig consensus
  and an NFL push table (a 3-point margin is ~9% of games), and labelled `est.`. Where no model applies
  (totals, live spreads) the better line wins, labelled `by line`. The odds shown are always the book's
  actual odds.

## 3. How we get the data from each book, and why

**DraftKings: REST snapshot, then socket deltas (a delta feed).** The site's own WebSocket pushes only
what changed. We fetch the snapshot in parallel with the socket handshake (live in 0.25–0.55 s instead
of ~2 s), apply each frame immediately, and reconcile against REST once a minute. Rejected: REST polling
(edge-cached for 1 s, slower than push) and MessagePack (positional arrays would silently misplace prices
if DK reordered them).

**FanDuel: push and poll raced (each message is a market's full state).** FD's website polls every 5 s,
but its bundle also carries an AppSync push channel ("PIR"). We use both: PIR push, plus a 1 s poll of
the uncached SMP price origin, per market, showing whichever channel has a new state first. Two feed
boxes interleave their polls (+0.5 s) so each IP stays at one request per second. Rejected: prices from
the cached board page (30–90 s old), polling at 5 s (~2.5 s average staleness), and push alone (it misses
changes the poll catches).

**No logins, cookies or sessions.** FD's two keys are public (in its web bundle); if FD rotates them the
connector re-reads the live bundle and adopts the working key (tested: live again in ~1.2 s). DK's socket
token is the literal `"default-token"` its site sends; if DK starts enforcing it, we fall back to DK's
anonymous JWT and renew it on DK's schedule.

## 4. Measured latency, and what we did to reduce it

**How we measure.** Each quote records the book's own change time (`bookTime`: DK `createdTime` in ms, FD
`updatedAt` in whole seconds) and our `receivedAt`; every channel's own arrivals are sampled before
cross-channel dedupe, so push and poll can be timed against each other. DK frames also carry
`publishedTime` and the gateway timestamp, which split DK's delay into engine, pipeline and network. Box
clocks follow Amazon Time Sync (µs-level); the dev server was checked against Google, AWS and FD `Date`
headers (±0.15 s). The browser beacons its own legs (server → browser, paint) to `/api/latency`, and
`scripts/measure-e2e.ts` measures end to end through the public URL.

| Measured | Result |
|---|---|
| FD push, book → backend (St. Louis, 143 markets, pregame) | p50 ~1.0 s raw (upper bound: `updatedAt` is truncated to the second; truncation-corrected ≈0.5 s) |
| FD, who shows a change first (Ohio, live, 337 changes) | push 182 · poll 151 · GraphQL 4; the poll led push by p50 235 ms on 288 of 297 differing observations |
| FD merge vs push alone (recorded live session) | 45% of new states shown earlier, mean 249 ms; 0 backward moves |
| FD poll-interval cost (replay, 773 states) | push only mean 102 ms / p90 355 ms; poll only 1 s 147 / 464 ms; poll only 5 s (FD's own site) 1.8 s / 4.0 s; **push + 1 s poll (shipped) is the reference**; push + 2 s poll +50 ms; push + 5 s poll +81 ms |
| FD poll cost | one ~3.4 KB gzipped request per second per box |
| DK socket / bootstrap (AWS Ohio) | subscribe → subscribed 35–63 ms; live 250–540 ms from start |
| Backend → browser (public URL, pregame smoke test) | first byte 30 ms; delta emit → receive p50 10 ms (n = 3) |
| Load: 500 viewers at ~18 deltas/s | 0 drops; emit → receive 44 / 158 / 460 ms (p50 / p90 / p99) |

**Not yet measured:** DraftKings book → backend per frame, and live (in-play) per-book end-to-end
figures, need real line movement. The Monday-night run (WAS @ SF, 3 hours, from the St. Louis dev server,
so not a Canadian vantage) was in progress when this was written; its raw output is in `docs/latency/`.
FD timestamps are whole seconds, so FD ages carry up to 1 s of truncation.

**What we did to cut latency**
- Push wherever a book has it: the DK socket and FD's PIR push.
- Race FD's uncached origin at 1 s (0.5 s combined across two boxes) instead of the site's 5 s.
- Show each FD price from whichever channel has it first, applying push in book order.
- Overlap startup work: DK's snapshot runs in parallel with the handshake; FD's push connects during
  discovery. Keep-alive connections stay warm.
- No batching in the connectors; the server coalesces only what changes in one event-loop turn into one
  delta (~550 bytes for a one-market move; the full 15-game snapshot is ~58 KB).
- Host in `us-east-2`, next to FD's push origin.

## 5. What we hit with each book, and what we'd do next

| | DraftKings | FanDuel |
|---|---|---|
| **Geo** | Not geofenced (Ohio and Canada hosts read it). Site/state names exist but the jurisdiction is ignored, so we can't say which region its prices represent. | Per-state market-id namespaces, but identical game lines across NJ, 11 other states, Ontario and Alberta. Not geofenced. |
| **Bot protection** | Akamai on every host. It blocked our Contabo dev server by IP/ASN, and it scores the HTTP client (`fetch` gets 200 where `https.request` gets 403 from the same IP). Solved with AWS `us-east-2` IPs, one HTTP client, and a probe before any host goes live. | PerimeterX on the HTML site only; the API hosts answer normally. The WAF rejects requests with no User-Agent. |
| **Rate limits** | None hit (one socket, one REST read per minute per box). | None hit (one SMP poll per second, one PIR socket per box). |
| **Credentials** | `"default-token"`, with a JWT fallback. | Public keys, re-read from the live bundle on rotation. |

When a book refuses us (401/403/429) the refused channel backs off (up to 10 minutes, honouring
`Retry-After`), the book is reported blocked, and the other book and the second feed box keep the board
fed. A book that goes down or sends bad data shows as stale in the UI instead of quietly showing old
numbers.

**With more time**
- Fill in live (in-play) latency per book end to end, and DK's engine → pipeline → gateway breakdown,
  from real line movement.
- Alerting for the cases that need a human (a book `down` for minutes; a key refresh that adopts nothing).
- Fixture-based tests for FanDuel's lifecycle, the way the DK replay harness mocks DraftKings.
- Verify which region DraftKings' feed represents (it ignores the jurisdiction name).
- **A third book, or ten:** each is a new `BookConnector` translator; the repetitive part (finding
  endpoints, mapping fields and team names) is where AI tooling helps. Point an agent at a site's bundle
  and network capture and have it draft the connector and a replay fixture for human review.
- Alternate lines and props (FD's event page carries `ALTERNATE_HANDICAP` / `ALTERNATE_TOTAL`; DK has
  alternate-line subcategories).
