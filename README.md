# Betstamp take-home: real-time NFL odds, DraftKings vs FanDuel

A live best-price board for NFL moneyline, spread and total (pregame and in-play) from DraftKings and
FanDuel, normalized into one model and pushed to the browser as lines move.

- **Live:** https://18-227-249-43.sslip.io
- **Code:** https://github.com/tristorez/BookComparisonTool

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
connectors also run alone: `npm run watch:fd`, `npm run watch:dk`, `npm run watch` (every book), or
`npm run watch -- <book>`.

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

**Books are pluggable. Adding one (a third, or ten) takes three edits, not a re-architecture:**
1. `src/books/<book>.ts`: a `BookConnector` subclass that maps the book's feed into games and quotes.
   The base class keeps state, diffs changes, tracks status and emits latency samples. `teams.ts` lines
   its games up with the other books', and `http.ts` / `odds.ts` handle requests, backoff and price parsing.
2. Its id in `BOOK_IDS` (`src/shared/domain.ts`).
3. One entry in `src/server/registry.ts`: name, badge color, staleness, timestamp resolution and how to
   build the connector, plus its own settings in `config.ts` if it has any.

The type checker flags a missing piece. Nothing else in the app names a book: config, the synthetic books
(`BOOKS=fake`), the board and best price, the stream, the second feed box, the UI (toggle, status chips,
game page) and `npm run watch -- <book>` all read the registry. `test/addBook.test.ts` runs a third book
through the board and best price with no other change.

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
| FD poll-interval cost (replay, 773 states) | push only mean 102 ms / p90 355 ms (misses 1.4% of states); poll only 1 s 147 / 464 ms; poll only 5 s (FD's own site) 1.8 s / 4.0 s; **push + 1 s poll (shipped) is the reference**; push + 2 s poll +50 ms; push + 5 s poll +81 ms |
| FD poll cost | one ~3.4 KB gzipped request per second per box |
| DK socket / bootstrap (AWS Ohio) | subscribe → subscribed 35–63 ms; live 250–540 ms from start |
| Backend → browser (public URL, pregame smoke test) | first byte 30 ms; delta emit → receive p50 10 ms (n = 3) |
| Load: 500 viewers at ~18 deltas/s | 0 drops; emit → receive 44 / 158 / 460 ms (p50 / p90 / p99) |

**What the numbers mean.** The path of one price change is: book's engine → book's publish step → book's
gateway → internet → our feed box → merge and emit → internet → browser → paint.
- **Book → server:** our receive time minus the book's own change timestamp: how old the price is when we get it.
  It includes the book's internal delay plus the network to us. We report every frame per feed.
- **DraftKings engine → publish:** `publishedTime − createdTime`, time *inside* DraftKings. Not network, not ours.
- **DraftKings gateway → server:** our receive time minus DK's gateway stamp: time on the wire to our box. This is
  the only leg that depends on where we host.
- **Server processing:** first-copy receive to the delta being emitted (merge, best price, serialize).
- **Second-copy lag:** how much later the slower feed box sees the same price. Not user-visible; it's the margin
  the second box buys.
- **Server → browser:** delta emitted to browser receive. **Paint:** receive to the next animation frame.
  **Book → browser:** browser receive minus the book's timestamp, the end-to-end number.
- FD's timestamps are whole seconds, so FD figures are upper bounds. Clock handling is in "How we measure"
  above.

**Game night: WAS @ SF, 2026-10-19 (8:00 pm ET, ~86 minutes live).** Book → our server, from the board on AWS
(every frame, p50 / p90 / p99, ms). FD's whole-second timestamps make its figures upper bounds.

| Book | Phase | p50 | p90 | p99 |
|---|---|---|---|---|
| DraftKings | pregame (216 frames) | 73 | 1,449 | 4,629 |
| DraftKings | **live** (2,314) | **1,186** | 2,509 | 7,124 |
| FanDuel push | pregame (97) | 1,042 | 1,451 | 1,602 |
| FanDuel push | **live** (929) | **968** | 1,366 | 1,847 |

- **DK's time is DK's.** Live, engine → publish is p50 1,097 ms; gateway → us is 19 ms (p99 109 ms); our
  processing is ~1 ms. The delay is DraftKings' pricing pipeline holding a change before it publishes.
- **FD direct** (dev server, 84 min): push p50 727 ms, p90 990 ms (502 changes); the 1 s poll was first on
  a large share of changes, which is why both channels run.
- **Two feeds racing:** the second copy of a price trails the first by p50 32 ms (DK) and 330 ms (FD); the
  box-to-box link adds p50 0 ms.
- **Backend → browser (live, indicative):** server → browser p50 ~24 ms, paint 1–9 ms. Only 3 clients were
  connected, so live browser-side samples are few (n = 4–5 per book). DK book → browser live was ≈1.8–2.0 s
  (n = 4), of which ~1.1 s is DK's own delay.
- **Health:** 0 aggregator errors, 0 invalid quotes, 0 dropped clients, 0 watchdog restarts; 81
  older-than-current updates correctly rejected.

Limits: one game, ~86 minutes, measured from the St. Louis dev server (not a Canadian vantage). Raw data is
in `docs/latency/`.

**What we did to cut latency**
- Push wherever a book has it: the DK socket and FD's PIR push.
- Race FD's uncached origin at 1 s (0.5 s combined across two boxes) instead of the site's 5 s.
- Show each FD price from whichever channel has it first, applying push in book order.
- Overlap startup work: DK's snapshot runs in parallel with the handshake; FD's push connects during
  discovery. Keep-alive connections stay warm.
- No batching in the connectors; the server coalesces only what changes in one event-loop turn into one
  delta (~550 bytes for a one-market move; the full 15-game snapshot is ~58 KB).
- Host in `us-east-2`, next to FD's push origin.
- **Tried and rejected:** a different DraftKings subscription (single-event, no market filter, live-only) to reach a
  faster path. Run side by side on a live game (`scripts/dk-variants.ts`, 128 price states), none beat the
  subscription we use; identical sockets differ from each other by ~70 ms, more than any variant did.

## 5. What we hit with each book, and what we'd do next

| | DraftKings | FanDuel |
|---|---|---|
| **Geo** | Not geofenced by state or country: AWS Ohio, Ashburn and Montréal all got byte-identical answers. We cannot choose a region: every state/province site name (`dkusnj`, `dkcaon`, `dkcaab`, even a made-up `zz`) returned the same bytes, so which jurisdiction its prices represent is unverified. | Region is chosen by hostname (`sbapi.<st>.sportsbook.fanduel.com`; Canada on `.ca`). 25 US states plus Ontario and Alberta answer; the other 26 states and the other provinces have no host. A Missouri IP reads NJ prices. Same keys work everywhere. |
| **Bot protection** | Akamai on every host. It blocked our Contabo dev server by IP/ASN, and it scores the HTTP client (`fetch` gets 200 where `https.request` gets 403 from the same IP). Solved with AWS `us-east-2` IPs, one HTTP client, and a probe before any host goes live. | PerimeterX on the HTML site only; the API hosts answer normally. The WAF rejects requests with no User-Agent. |
| **Rate limits** | None hit. We run one socket and one REST read per minute per box. A stepped test from the t3.micro (8 s per step) ran the REST snapshot at 1, 2, 5 and 10 req/s: 144 requests, all 200, p50 105–139 ms. | None hit. We run one SMP poll per second, one PIR socket and a board refresh every 30 s per box. The same test ran SMP prices (70 markets) at 2, 5, 10 and 20 req/s: 296 requests, all 200, p50 15–27 ms. The board page ran at 1, 2 and 4 req/s: 56 requests, all 200. |
| **Credentials** | `"default-token"`, with a JWT fallback. | Public keys, re-read from the live bundle on rotation. |

**Geo, in more detail (tested 2026-10-19, one pregame snapshot, from AWS Montréal, Ashburn and Ohio).**
- **Prices don't differ by region.** FanDuel's moneyline, spread and total matched NJ on 90 of 90 runners
  in 11 other states, Ontario and Alberta, and on the live price endpoint for PA, NY, IL and Ontario.
  Game props matched too. What differs is market-id namespaces and a few futures (103 markets in NJ and
  Ontario, 101 in PA/OH, 96 in NY/VA). An Ontario column would show the same prices, so we ship NJ.
- **Server location didn't change answers.** Canada, US-east-1 and Ohio got the same bytes from both books.
  Reports that these APIs reject Canadian IPs did not reproduce from an AWS Canada address; we did not
  test residential or other IP ranges.
- **What blocks us is IP reputation, not location.** DraftKings' Akamai refused our St. Louis dev server
  outright while AWS addresses in the same country were fine, so the hosting choice is about reputation
  (see Bot protection), not geography.
- **Limits:** one pregame snapshot; no live markets, promos or logged-in prices tested; DraftKings'
  jurisdiction stays unverified because it ignores the region we request.

**Rate-limit test (2026-10-19, from the production t3.micro, during live traffic).** Each endpoint was
stepped up for 8 s per step and stopped at the first non-200. Nothing was refused, so we did not find a
ceiling: these are floors, not limits. The shipped rates (1 SMP poll per second per box) are well below
them. Short bursts from one IP say nothing about sustained rates or other IPs, and we did not push
higher to avoid burning the feed's IP.

When a book refuses us (401/403/429) the refused channel backs off (up to 10 minutes, honouring
`Retry-After`), the book is reported blocked, and the other book and the second feed box keep the board
fed. A book that goes down or sends bad data shows as stale in the UI instead of quietly showing old
numbers.

**With more time**
- Longer latency runs: a full slate, a Canadian vantage point and many more connected clients, to firm up
  the live browser-side figures.
- Alerting for the cases that need a human (a book `down` for minutes; a key refresh that adopts nothing).
- Fixture-based tests for FanDuel's lifecycle, the way the DK replay harness mocks DraftKings.
- Verify which region DraftKings' feed represents (it ignores the jurisdiction name).
- **A third book, or ten:** the code side is the three edits in Architecture. The slow part is
  reverse-engineering each site (endpoints, fields, team names, bot protection), and that is where AI
  tooling helps: point an agent at a site's bundle and network capture and have it draft the connector
  and a replay fixture for human review. Toward ten, give each book its own egress (process or box), since
  each brings its own geo and bot-protection constraints.
- Alternate lines and props (FD's event page carries `ALTERNATE_HANDICAP` / `ALTERNATE_TOTAL`; DK has
  alternate-line subcategories).
