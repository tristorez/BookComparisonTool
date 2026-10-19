# Betstamp take-home: real-time NFL odds, DraftKings vs FanDuel

Pulls NFL main-line odds (moneyline / spread / total, pregame and in-play) from DraftKings and FanDuel,
normalizes both books into one model, and serves a live best-price board to the browser.

> **Status (2026-10-19):** both book connectors are built, hardened, and verified live from our AWS
> host in `us-east-2`.
> - **Live at https://18-227-249-43.sslip.io**: the board, Server-Sent Events push, the UI and Box B's
>   feed link are deployed. See [The board](#the-board-two-feeds-one-view), [Best price](#best-price)
>   and [Serving](#serving-the-board-server-sent-events); every decision is in
>   [Decisions.txt](Decisions.txt).
> - FanDuel is live 0.2 s after start. DraftKings is live in 0.25–0.55 s.
> - All 15 games and every side line up one-to-one across the two books.
> - Every failure path we could script (dead socket, server close, REST outage, bad snapshots,
>   finished games, rotated or enforced credentials) was exercised, live or against a local replay of
>   DraftKings' protocol. See [Reliability](#reliability-staying-up-and-honest-when-not).
> - Nothing depends on a login, cookie or session, and the two credentials that could change recover
>   on their own. See
>   [Cookies, tokens and sessions](#cookies-tokens-and-sessions-what-expires-and-how-we-recover).

---

## Contents

1. [Running the app](#running-the-app)
2. [Running the connectors locally](#running-the-connectors-locally)
3. [Architecture](#architecture)
4. [Key decisions](#key-decisions)
5. [Getting the data: FanDuel](#getting-the-data-fanduel)
6. [Getting the data: DraftKings](#getting-the-data-draftkings)
7. [What we hit: geo, bot protection, rate limits, credentials](#what-we-hit-geo-bot-protection-rate-limits-credentials)
   - [Cookies, tokens and sessions: what expires, and how we recover](#cookies-tokens-and-sessions-what-expires-and-how-we-recover)
8. [Reliability: staying up, and honest when not](#reliability-staying-up-and-honest-when-not)
9. [Normalization and matching](#normalization-and-matching)
10. [The board: two feeds, one view](#the-board-two-feeds-one-view)
11. [Best price](#best-price)
12. [Serving the board: Server-Sent Events](#serving-the-board-server-sent-events)
13. [The UI](#the-ui)
14. [Latency: measured so far](#latency-measured-so-far)
15. [Hosting: region, instances and network](#hosting-region-instances-and-network)
16. [Issues hit and how we got around them](#issues-hit-and-how-we-got-around-them)
17. [What we'd do next](#what-wed-do-next)

**Where the brief's questions are answered**

| The brief asks for | Where |
|---|---|
| A live URL and a GitHub repo | Live URL: the status note above. Repo link: added when the repo is published. |
| How to run it locally | [Running the app](#running-the-app) |
| Architecture overview | [Architecture](#architecture), [The board](#the-board-two-feeds-one-view) |
| How we get the data from each book, and why | [FanDuel](#getting-the-data-fanduel), [DraftKings](#getting-the-data-draftkings) |
| Measured latency per book, pregame and live; the method; what we did to reduce it | [Latency](#latency-measured-so-far) |
| What we hit with each book: geo, bot protection, rate limits | [What we hit](#what-we-hit-geo-bot-protection-rate-limits-credentials); every incident in [Issues](#issues-hit-and-how-we-got-around-them) |
| "If your solution depends on a cookie, token or session, what happens when it expires, and how does your system recover without a human?" | [Cookies, tokens and sessions](#cookies-tokens-and-sessions-what-expires-and-how-we-recover) |
| What we'd do next | [What we'd do next](#what-wed-do-next) |
| *Speed:* snapshots vs deltas, push to the browser, payload size, batching, hosting | [Latency](#latency-measured-so-far) ("What we did to cut latency"), [Serving](#serving-the-board-server-sent-events), [Hosting](#hosting-region-instances-and-network) |
| *Getting the data:* FanDuel's fastest path, what we tried, the poll interval and what it costs | [FanDuel](#getting-the-data-fanduel); [Key decisions](#key-decisions) 1 and 22 |
| *Matching:* one clean model; which book sends full state and which sends changes; best price on different lines | [Normalization](#normalization-and-matching); DraftKings sends [deltas](#getting-the-data-draftkings), FanDuel [full state](#getting-the-data-fanduel); [Best price](#best-price) |
| *Backend:* one ingestion per book, many viewers, a third book | [Architecture](#architecture), [Serving](#serving-the-board-server-sent-events) ("Many viewers"), [What we'd do next](#what-wed-do-next) |
| "We will ask you to defend each choice" | [Key decisions](#key-decisions) (summary); [Decisions.txt](Decisions.txt) (full log, indexed by the brief's sections) |

---

## Running the app

```bash
nvm use                      # Node 24.22.0 (.nvmrc); engine-strict is on
npm ci
npm run dev                  # board server (:8080, real books) + Vite dev server (:5173)
BOOKS=fake npm run dev       # synthetic books: no network, works anywhere (including outside the US)
VITE_API_TARGET=https://18-227-249-43.sslip.io npm run dev:remote   # local UI against the live server
npm test                     # best price, merge (incl. a live FD replay), board, SSE + feed link over real sockets, UI
npm run drills               # failure drills: a board and a feed process over a real link, synthetic books (~5 min)
npm run build && npm start   # production build: one Node process serves the API, the stream and the site
```

Settings are environment variables read by `src/server/config.ts`; [`.env.example`](.env.example) lists the
main ones, and the board also reads a local `.env` (gitignored; the environment wins). `deploy/deploy.sh`
builds on Box A and rolls out to both boxes (`deploy/` has the systemd units and the Caddyfile; the hosts go
in a gitignored `deploy/hosts.env`).

**Viewing and running from Canada.** The live URL works from anywhere. Its prices are both books' **New
Jersey** lines. We measured FanDuel NJ, 12 other states, Ontario and Alberta: the game lines and
props are identical ([FD-16](#fd-16-every-region-prices-the-games-the-same)), so the Ontario lines in the app
should match for these markets. DraftKings ignores the jurisdiction name altogether
([DK-17](#dk-17-the-jurisdiction-name-is-ignored-so-we-cannot-choose-a-draftkings-region)), so we can't say
which region its feed represents. We reached both books from an AWS Canada instance, so Canadian IPs are
not blocked there ([FD-9](#fd-9-geography)); `npm run dev` from a home or VPS address may still be
blocked, in which case use `npm run dev:remote` (live data through our server) or `BOOKS=fake`.

> **Every decision and its reasoning, alternatives and evidence: [Decisions.txt](Decisions.txt).**

---

## Running the connectors locally

The connectors also run on their own, without the board, for debugging and measurement. Same Node 24
requirement (`>=24.15 <25`).

```bash
npm ci
npm run watch:fd        # FanDuel connector: prints every normalized price change + latency summary
npm run watch:dk        # DraftKings connector (needs an egress IP DraftKings accepts, see below)
npm run watch           # both, plus a side-by-side DK / FD board and process stats in each summary
npm run probe           # can this machine reach both books? (also runs standalone, see below)
npx tsx scripts/replay-merge.ts   # re-measure the push/poll merges against a recorded live FD session
npm run typecheck
```

Connector environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `FD_REGION` | `nj` | FanDuel state subdomain. Each state has its own market-id namespace. |
| `FD_POLL_MS` | `1000` | SMP poll cadence, raced against push. `0` disables polling. |
| `FD_POLL_PHASE_MS` | `0` | Wall-clock phase of the poll schedule. A second feed host uses `500` to interleave. |
| `FD_PUSH` | on | `0` disables the PIR push subscription. |
| `DK_STATE` | `nj` | DraftKings jurisdiction (`dkusnj`, `sportsbook-ws-us-nj`). |
| `DK_PROXY_URL` | (none) | HTTP(S) proxy for both DK channels, e.g. `http://user:pass@host:port`. |
| `DK_REST_PROXY_URL` / `DK_WS_PROXY_URL` | (none) | Proxy only the REST snapshot, or only the socket. |
| `FD_APP_KEY` / `FD_PIR_KEY` | FD's current keys | Starting keys. Set either to a wrong value to watch the connector fetch FanDuel's current keys from its bundle. |
| `DK_TOKEN_MODE` | `default` | `anonymous-jwt` runs the DK socket on DK's anonymous JWT, the fallback used if DK refuses `"default-token"`. |
| `WATCH_SECONDS`, `WATCH_SUMMARY_MS`, `WATCH_QUIET=1` | | Harness controls. |

**Where you run it matters.** Check a host before running or deploying there:

```bash
node scripts/probe-egress.mjs --state nj --seconds 10   # zero dependencies; copy this one file to any box
```

It exercises every channel exactly as the connectors use it: the same built-in `fetch` client, DK REST
plus socket subscribe, and FD board plus SMP plus PIR. It prints a verdict such as "DK socket OK, REST
blocked → proxy only the snapshot calls".
- Both books' US APIs are reported to require a US IP (we haven't verified it; see
  [FD-9](#fd-9-geography)).
- DraftKings additionally rejects many datacenter IP ranges at its CDN (see
  [DK-1](#dk-1-akamai-denies-every-draftkings-host-from-our-dev-server)).

---

## Architecture

```
                       ┌─ feed: one connector per book, the same on box A and box B ────────────────┐
  DraftKings           │                                                                            │
   REST snapshot ──────┼─▶ DraftKingsConnector: snapshot, then socket deltas; 60 s reconcile        │
   JSON-RPC socket ────┼─▶                                                                          │
  FanDuel              │                                                                            │
   board page ─────────┼─▶ FanDuelConnector: discovery from the board page;                         │
   SMP poll ───────────┼─▶ MarketMerge races the 1 s poll against push, per market                  │
   PIR push ───────────┼─▶                                                                          │
                       │                                                                            │
                       │ emits `sample` (each channel's own observations), `change` (diffed         │
                       │ batches: games, removals) and `status` (live / degraded / down)            │
                       └──────────────────────────────────────┬─────────────────────────────────────┘
                                                              │ box A: in the same process · box B: TCP 7070
                       ┌─ board (box A only) ─────────────────▼─────────────────────────────────────┐
                       │ cross-feed merge (first copy wins) → best price → staleness →              │
                       │ SSE hub: each event-loop turn's changes serialized once, sent to every tab │──▶ browsers
                       └────────────────────────────────────────────────────────────────────────────┘
```

**Deployment (AWS `us-east-2`).** Two feed boxes on separate IPs, one board:

```
                ┌─────────── box A · t3.medium · Elastic IP ────────────┐
  DraftKings ◀─▶│ feed: DK socket + REST · FD push + poll (phase 0.0 s) │
  FanDuel    ◀─▶│   │                                                    │
                │   ▼                                                    │
                │ board: keeps the first copy of each change,            │──▶ browsers
                │        tracks health per feed and book                 │
                │   ▲                                                    │
                └───┼────────────────────────────────────────────────────┘
                    │ private VPC link, TCP 7070 (open only to box B's security group)
                ┌───┴─────────── box B · t3.micro ───────────────────────┐
  DraftKings ◀─▶│ feed: DK socket + REST · FD push + poll (phase 0.5 s) │
  FanDuel    ◀─▶│                                                        │
                └────────────────────────────────────────────────────────┘
```

**Principles**
- **One ingestion per book, not per browser.** A connector is a long-lived object that owns its
  connections and emits normalized `change` batches. Fan-out happens after normalization.
- **A third book is a new translator, not a re-architecture.** `BookConnector` (`src/books/types.ts`)
  owns:
  - state, and diffing so that only real changes are emitted;
  - status;
  - per-channel `sample` events;
  - crash-isolated event dispatch.

  A connector only maps its feed into `BookGame` and `Quote` objects and calls `commit()`.
- **Every quote carries its provenance.**
  - `bookTime` is the book's own change timestamp.
  - `receivedAt` is when we received it.
  - `channel` is `snapshot`, `push` or `poll`.
  - `sample` events report each channel's own observations before cross-channel dedupe, so
    per-channel latency isn't biased toward whichever channel won. The board merges quote values from
    them.
- **Every book reports health:** `connecting` / `live` / `degraded` / `down`, plus a detail string and
  `lastDataAt`. One book's numbers are marked stale while the other keeps updating.

```
src/books/              one connector per book, on a shared base
  types.ts                normalized model + BookConnector (diffing, status, samples, safe dispatch)
  fanduel.ts              FanDuel: discovery, SMP poll, PIR push, MarketMerge, key refresh
  draftkings.ts           DraftKings: REST snapshot, socket deltas, reconcile, token fallback
  teams.ts, odds.ts       NFL teams and the game key; American/decimal parsing (DK's U+2212 minus)
  http.ts                 one HTTP client (fetch + undici dispatcher), proxies, backoff, block detection
src/shared/             browser-safe: domain types, wire format, best price, push table
src/server/             the board process: board, cross-feed merge, SSE hub, latency, API, registry, fakes
src/feed/               the feed-only process (box B)
src/feedlink/           the box B → box A link: NDJSON protocol, client and server
src/scripts/watch.ts    terminal harness for the connectors
web/                    the React UI
deploy/                 systemd units, Caddyfile, deploy.sh, and *.env.example templates (real hosts,
                        addresses and the feed token live in gitignored files and in /etc/odds/)
scripts/                probe-egress, replay-merge, build-push-table, measure-e2e, load-sse, drills
test/                   vitest suites and the live FD fixture
```

---

## Key decisions

Each decision states what we chose, why, what we rejected, and where the evidence is. The full log, with
trade-offs and what would change our mind, is [Decisions.txt](Decisions.txt).

### Getting data
1. **FanDuel: PIR push and a 1 s SMP poll, raced.**
   - FD's own site polls SMP every 5 s, but its bundle also carries an AppSync push channel ("PIR").
     We use both.
   - *Rejected:* prices from the CDN-cached board page (30–90 s old); polling at the site's 5 s (~2.5 s
     average staleness from the poll alone, against ~0.5 s at 1 s); push alone (it's ~0.25–0.5 s behind
     the poll on 45% of changes).
   - *Rejected:* polling PIR's GraphQL query (it has timestamps, but trails push by 1.4 s at p50).
   - → [FanDuel](#getting-the-data-fanduel)
2. **FanDuel merge rules (`MarketMerge`).**
   - Push applies in `updatedAt` order.
   - Otherwise, whichever channel shows a different state first wins.
   - On a live recording this shows 45% of new states before push (mean 249 ms earlier), with zero
     wrong-way flips and zero states shown late.
   - *Rejected,* each measured on the same recording:
     - "never re-show a recently superseded state" delayed 35 states;
     - holding push while a poll leads delayed 10 states by ~0.6 s;
     - the old request-timing guard never triggered.

     None of them prevented a flip.
   - → [How push and poll are merged](#how-push-and-poll-are-merged)
3. **DraftKings: REST snapshot plus socket deltas, in JSON.**
   - The snapshot is fetched *in parallel* with the socket handshake, with a resync 2 s later. Live in
     0.25–0.55 s instead of ~2 s.
   - *Rejected:* MessagePack. Its positional arrays would silently misplace prices if DK reordered them,
     and the bytes it saves don't matter on frames that carry only what changed.
   - *Rejected:* REST polling (cached at the edge for 1 s, and slower than push); a socket-only bootstrap
     (`initialData` is ignored, tested); a sequential snapshot after a 1.5 s settle (cost 1.5 s on every
     reconnect).
   - → [DraftKings](#getting-the-data-draftkings)
4. **No logins, cookies or sessions, and the two credentials that could change heal themselves.**
   - FD's `_ak` and PIR client key are public, in its web bundle. DK's socket gets the literal
     `"default-token"` its own site sends, and checks nothing today.
   - If FD rotates a key, the connector re-reads FD's live bundle and adopts the key FD's API accepts
     (live test from wrong keys: adopted in 0.95 s, live at 1.16 s). SMP polling needs no key, so prices
     keep flowing meanwhile.
   - If DK starts enforcing the token, the connector switches to DK's anonymous JWT and renews it on
     DK's own schedule (mock test: live again within 0.7 s of the first refusal; JWT mode verified live).
   - *Rejected:* logged-in sessions (expiry and account risk, and no extra odds); cookies harvested by
     a headless browser (brittle, and it walks into PerimeterX).
   - → [Cookies, tokens and sessions](#cookies-tokens-and-sessions-what-expires-and-how-we-recover)

### Staying up
5. **Detect dead sockets in about 12 s.** We ping every 5 s and reconnect after 12 s of silence.
   - DK answers pings in about 30 ms. AppSync answers about 1 s late and sends its own keepalive only
     every 60 s; both measured.
   - *Rejected:* 15 s pings with a 45 s limit, which left a dead DK socket unnoticed for up to 60 s.
6. **Reconnect fast, then back off, and back off hard when blocked.**
   - The first retry comes within 250 ms, growing exponentially to 30 s. The backoff resets after 30 s
     of stable connection.
   - DK's own floor applies after closes `4001`/`1013` (≥5 s). A `4000` counts as a token refusal
     ([DK-4](#dk-4-the-socket-wants-a-jwt)).
   - On 401/403/429, the sockets, DK's bootstrap snapshot and FD's poll back off up to 30 s, doubling to
     10 min, and honour `Retry-After` on HTTP answers. DK's once-a-minute reconcile and FD's 30 s board
     refresh keep their slow cadence. Hammering a CDN that is refusing us only deepens the block.
7. **Never show stale data as fresh.**
   - Each book reports `live` / `degraded` / `down`.
   - An empty response counts as a failure, not a heartbeat.
   - If DK's REST fails after a reconnect, the last board keeps updating from live deltas, *labelled
     `degraded`*, and only if we were live within the last 2 minutes.
8. **Distrust bad reads.**
   - Malformed snapshots are rejected.
   - A snapshot that would drop more than 30% of the games at once (with 4 or more held) must be
     confirmed by a read 30 s later. DK removes finished games over the socket, so mass drops via REST
     are suspect.
   - Values the socket touched in the last 10 s survive a reconcile.
   - A connection epoch discards async work from a previous connection.
9. **Prove the subscription, not just the socket.**
   - DK resubscribes (make-before-break) when live games see no update frame for 45 s, or when a
     reconcile corrects 3 or more quotes.
   - FD swaps in a new PIR subscription set only after it is acknowledged; the old set keeps running
     until then.
10. **A consumer bug cannot stop ingestion.** Every listener runs in its own try/catch, and errors are
    counted.

### Matching
11. **Game key = kickoff date (US Eastern) + `AWAY@HOME`, with teams matched by unique nickname.**
    - Books disagree on kickoff by a minute, and abbreviations collide ("NY", "LA").
    - Labels with parentheses, e.g. simulated eFootball teams, are rejected outright.
    - → [Normalization](#normalization-and-matching)
12. **A quote is (book, game, market, side).** It changes only when the American price, line,
    suspension or live flag changes. DK line moves replace selection ids, and FD's two channels report
    decimals at different precision.
13. **Best price across different lines: rules R1–R5.**
    - Moneyline and same-line prices take the higher payout (exact).
    - Pregame spreads on different lines are scored by estimated return per $1 against the books'
      no-vig consensus plus an NFL push table (3 lands 9.2%), labelled `est.`.
    - Totals, live spreads and spreads with no consensus go line first, then price, labelled `by line`.
    - *Rejected:* line first everywhere. It ignores how big the price gap is: −3 −130 would beat
      −3.5 +100.
    - *Rejected:* each book's own no-vig. It scores both sides of a market identically, so the same
      book would win both.
    - → [Best price](#best-price)

### Architecture and hosting
14. **One long-lived ingestion per book** (see [Architecture](#architecture)).
15. **Two active feed boxes on separate IPs, and one board that keeps the first copy of each change.**
    - Blocks are driven by IP reputation, not volume, so the protection is a second IP rather than a
      faster poller.
    - With both active there is no failover decision and no cold start.
    - FD polls are staggered by 0.5 s (`pollPhaseMs`), halving the effective poll interval at 1 request
      per second per IP.
    - *Rejected:* an aggressive primary with a passive backup. The aggressive box is likeliest to be
      blocked, and failover would start cold.
16. **Last resort: a US residential/ISP proxy, for DK only, only if both AWS IPs are blocked.** Proxies
    are supported per channel; we haven't needed one.
17. **AWS `us-east-2` (Ohio).**
    - FD's push service runs there (1–5 ms away, against 26–62 ms from our St. Louis dev server), and
      DK accepts these IPs.
    - *Rejected:* `us-east-1`. It might be ~10 ms closer to DK but ~10 ms farther from FD.
    - → [Hosting](#hosting-region-instances-and-network)
18. **Box A `t3.medium` (board, website, feed), box B `t3.micro` (feed).** Ingestion uses 1–2% of a core
    and ~140 MB. We chose `t3` over `t2`: no hard CPU throttle, and 2 vCPUs.
19. **An Elastic IP on box A only.** It gives the site and DK's IP-reputation checks a stable address.
    We re-probed after attaching it.
20. **One HTTP client.** The connectors and the egress probe both use Node's built-in `fetch`, with an
    undici 7 dispatcher for keep-alive and proxies. Akamai scores the client, so a passing probe must
    predict the connector.

### Scope, rates and access
21. **New Jersey lines from both books.**
    - Each book prices per state, and each state is its own namespace (FD market ids `734.x` for NJ,
      `729.x` for Missouri; DK `dkusnj`), so a fair comparison reads both books for the same state.
    - Reading isn't geofenced per state: our Ohio hosts read NJ from both books.
    - *Update after testing from AWS Canada and US-east-1:* FD's game lines and props were identical in
      NJ, 12 other states, Ontario and Alberta ([FD-16](#fd-16-every-region-prices-the-games-the-same)), so
      Ontario lines would add nothing; and DK ignores the jurisdiction name, so "NJ" on the DK side is
      unverified ([DK-17](#dk-17-the-jurisdiction-name-is-ignored-so-we-cannot-choose-a-draftkings-region)).
    - *Rejected:* a separate Ontario column. Canadian IPs are not blocked, but the prices matched.
    - → D-03 in [Decisions.txt](Decisions.txt); the Canada note in [Running the app](#running-the-app)
22. **Modest, fixed request rates, the same on each box.**
    - FD: one SMP poll per second, one PIR socket, a board refresh (two requests) every 30 s. DK: one
      socket and one REST read per minute, plus two per reconnect (the bootstrap and a resync 2 s later).
    - **Why 1 s for FD.** A poll every P seconds is P/2 stale on average: ~2.5 s at FD's own 5 s, ~0.5 s
      at 1 s. At 1 s the poll still shows 45% of new states before push does, and the second box
      interleaves at +0.5 s, so the board polls every 0.5 s while each IP stays at 1 per second.
    - *Rejected:* 0.5 s polling from one IP. It doubles one IP's footprint, and blocks follow IP
      reputation, so a second IP protects more than a faster poller.
    - No 429 or other rate-limit response at these rates, in development or in either box's service log.
    - → D-16 and D-36 in [Decisions.txt](Decisions.txt);
      [What we hit](#what-we-hit-geo-bot-protection-rate-limits-credentials)

---

## Getting the data: FanDuel

FanDuel runs on Flutter's Betfair-derived platform. The price origin answers `server: Cougar`
(Betfair's service framework), and sports use Betfair event-type ids (`6423` = American football).
Everything below is public and read without cookies or login. We found it in FanDuel's current web
bundle and verified every piece with live requests.

| Endpoint | What it is | How we use it |
|---|---|---|
| `GET sbapi.{state}.sportsbook.fanduel.com/api/content-managed-page?page=CUSTOM&customPageId=nfl&_ak=…` | The NFL board: events, markets, runners (`result.type` = HOME/AWAY/OVER/UNDER). | **Discovery only**, every 30 s (retrying with backoff from 2 s while failing). It's CDN-cached `max-age=30, stale-while-revalidate=60`, so its prices can be ~90 s old. |
| `GET sbapi.{state}…/api/in-play?eventTypeId=6423&_ak=…` | Football events in play. | Second discovery source for live games. |
| `POST smp.{state}.sportsbook.fanduel.com/api/sports/fixedodds/readonly/v1/getMarketPrices` | Current prices, uncached. Returns the **full state** of each requested market and leaves closed ones out. | First prices for new markets, and a **1 s poll** on wall-clock slots (`phase + k·1 s`). All 45 NFL main markets fit one request; ~3.4 KB gzipped; ~12 ms from Ohio. |
| `wss://pir.{state}.sportsbook.fanduel.com/graphql/realtime`, AppSync `onUpdateMarketPrice(ids)` | **FanDuel's push-pricing channel** ("PIR"): AppSync GraphQL over WebSocket, authenticated with a static public client key from the bundle (re-read from the live bundle if FD rotates it). Each frame is one market's full state plus `updatedAt` (whole seconds). | Subscribed for every tracked NFL main market. It connects in parallel with the first discovery. |

**Why this approach**
- **What FD's own board does:** it polls SMP every **5 s** (`pollingConfig: {refreshTimeInMs: 5000}`
  in the bundle).
- **The faster path the site already has:** the same bundle wires PIR into the betslip (behind a flag)
  and hands it to the native apps (`PushPricingDetails`). That is the fastest path "the site itself
  uses", so we subscribe the whole board to it.
- **Why we race both:** they deliver the same states at nearly the same time, and each wins about half
  the races. From Ohio, over 337 changes on 70 live markets:
  - push was first 182 times, SMP 151 times, and PIR's GraphQL query 4 times;
  - SMP's lead over push was p10 −485 ms, p50 −44 ms, p90 +473 ms.

  Racing them takes the minimum. The poll also covers anything push might drop.
- **Full state, not deltas:** both channels deliver a market's **full current state** every time, so
  FanDuel needs no delta bookkeeping.

### How push and poll are merged

`MarketMerge` (in `src/books/fanduel.ts`) decides per market which observation is shown:
1. **Push applies in `updatedAt` order.** A frame older than one already applied is dropped.
2. **Otherwise, whichever channel shows a different state first wins.**

**How we chose these rules.**
- **The data.** We recorded 3 minutes of live FD traffic from box A: 70 in-play markets, 696 push frames
  and 179 polls.
- **Ground truth.** Push's own ordered sequence. A poll that's ahead is matched to the push frame that
  later confirms it.
- **What SMP does when it differs from push.**
  - 297 poll observations differed from push's latest state.
  - **288 were ahead of push**, by p50 235 ms / p90 460 ms.
  - **0 were stale reads** of a state push had already left.
  - 9 were states push never sent.

| Strategy | Wrong-way flips | States shown before push | States shown late |
|---|---|---|---|
| Push only | 0 | 0 of 693 | 312 (p50 235 ms) |
| …plus "never re-show a recently superseded state" | 0 | **277** of 693 | 35 |
| …plus "hold push while a poll leads" (≤1.5 s) | 0 | 312 of 693 | **10** (p50 595 ms, max 779 ms) |
| Old request-timing guard | 0 | 312 of 693 (it never triggered) | 0 |
| **`MarketMerge` (shipped)** | **0** | **312 of 693 (mean 249 ms earlier)** | **0** |

"Shown late" counts states that appeared after their first arrival on any channel.
- **Why "superseded" blocking hurt.** Prices oscillate (S → L → S) and the poll often sees the reversal
  first. A rule aimed at stale replica reads, which never occurred, only delayed real moves.
- **Why the push hold hurt.** It was meant to stop two quick moves inside push's ~0.5 s lag from
  flickering back. Instead it delayed push's next state whenever the poll had shown a transient state
  push never sends.
- **Reproduce it.** `npx tsx scripts/replay-merge.ts` replays the recording, kept as
  `test/fixtures/fd-live-2026-10-19.jsonl.gz` and trimmed to the fields the merge reads. It runs both
  this connector merge and the board's cross-feed merge.

**Lifecycle**
- **Markets come and go.**
  - Discovery adds markets and refreshes each market's runner→side map.
  - A market SMP omits on 3 consecutive polls is closed and its quotes removed. It is tombstoned for
    2 minutes, so the CDN-cached board can't re-add it.
  - An unknown runner id triggers an immediate, rate-limited board refresh.
- **Push resubscribes safely.** The subscription set changes only once its replacement is acknowledged.
  A rejected start leaves the old set running and retries with backoff.
- **Polls are bounded.** Each poll times out after 2 s (healthy reads take 10–60 ms). An empty answer
  is a failure, not proof the prices are current.

---

## Getting the data: DraftKings

DraftKings' web client (its `dk-data-layer` library, served from `cdn.draftkings.com`) loads a REST
snapshot and then receives **deltas** over a JSON-RPC 2.0 WebSocket.

| Endpoint | What it is |
|---|---|
| `GET sportsbook-nash.draftkings.com/api/sportscontent/dkus{st}/v1/leagues/88808/categories/492/subcategories/4518` | NFL "Game Lines → Game" snapshot: `events`, `markets`, `selections`, plus `subscriptionPartials`, the exact socket query the client should send. |
| `wss://sportsbook-ws-us-{st}.draftkings.com/websocket?format=json&locale=en` | JSON-RPC socket. We send `{"jsonrpc":"2.0","method":"subscribe","params":{"entity":"events","queryParams":{"query":"$filter=leagueId eq '88808' and clientMetadata/Subcategories/any(s: s/Id eq '4518')…","includeMarkets":"…","initialData":false,"projection":"sportsbook"},"jwt":"default-token","siteName":"dkusnj",…}}`. Frames carry `add` / `change` / `remove` lists of events, markets and selections, plus DK's `createdTime` (engine), `publishedTime` (pipeline) and `websocketPublishTimestamp` (gateway). |

**How the connector works**
- **Parallel bootstrap.** On every (re)connect:
  1. Start the REST snapshot.
  2. In parallel, open the socket and subscribe.
  3. Buffer frames until the subscription is acknowledged and the snapshot has arrived.
  4. Apply the snapshot, then replay the buffer.
  5. Two seconds later, run a resync (a reconcile) to close any gap left by DK's REST edge cache
     (`cache-control: public,max-age=1`): the snapshot can predate the subscription.

  Measured from Ohio: **live in 250–540 ms**. Opening the socket through Akamai and getting the
  subscription acknowledged takes 246–516 ms (the subscribe round trip itself is 35–63 ms; the rest is
  TCP, TLS and the upgrade), and the snapshot (180–245 ms) completes inside that window.
- **Deltas, not snapshots.**
  - DK sends only changes. `change` objects are **partial** (a selection change has no `marketId`), so
    we keep full state and merge.
  - There are no sequence numbers and no replay, and `initialData: true` is ignored (tested), so every
    reconnect re-snapshots over REST.
  - A **60 s REST reconcile** corrects anything a lost frame left wrong. Values the socket touched in the
    last 10 s are kept, so a lagging REST read can't roll a fresh price back.
- **Line moves** arrive as `remove` (old selection) plus `add` (new selection with `replacedSelectionId`),
  and partial `change`s sometimes arrive before the `add`.
  - Quotes are keyed by (game, market, side), never by selection id.
  - Early changes are held until their `add` arrives.
  - A side's removal waits up to 1 s for its replacement, so the board never blinks during a move.
- **Game states.** DK's own enum is `NOT_STARTED` / `STARTED` / `FINISHED`. Live means `STARTED`;
  `FINISHED` retires the game; unknown statuses are logged.
- **JSON, not MessagePack.**
  - DK's site uses `format=msgpack`, which encodes entities as **positional arrays**.
  - `format=json` carries the same frames with named fields; each frame carries only what changed.
  - With positional decoding, a reordered schema would silently put a price in the wrong slot.
- **Token.** The subscribe carries `jwt: "default-token"`, as DK's site does. If DK ever refuses it, the
  connector switches to DK's anonymous JWT (see
  [Cookies, tokens and sessions](#cookies-tokens-and-sessions-what-expires-and-how-we-recover)).

---

## What we hit: geo, bot protection, rate limits, credentials

| | DraftKings | FanDuel |
|---|---|---|
| **Geo** | Site names exist per state (`dkusnj`, `sportsbook-ws-us-nj`) but are ignored ([DK-17](#dk-17-the-jurisdiction-name-is-ignored-so-we-cannot-choose-a-draftkings-region)). Not geofenced: our Ohio and Canada hosts read it. | Own market-id namespace per region ([FD-3](#fd-3-market-ids-are-per-state-namespaces)), but identical game lines and props across regions ([FD-16](#fd-16-every-region-prices-the-games-the-same)). Not geofenced by state or country ([FD-9](#fd-9-geography)). |
| **Bot protection** | **Akamai on every host.** It denied our Contabo dev server outright, by IP/ASN reputation ([DK-1](#dk-1-akamai-denies-every-draftkings-host-from-our-dev-server)). It also scores the HTTP client: `fetch` gets 200 where `https.request` gets 403, from the same AWS IP ([DK-10](#dk-10-akamai-scores-the-client-not-just-the-ip)). Solved by AWS `us-east-2` IPs, one HTTP client, and a probe before any host goes live. | **PerimeterX on the HTML site only** ([FD-1](#fd-1-perimeterx-human-blocks-the-html-site-from-our-datacenter-ip)). The API hosts answer normally. Its WAF rejects a request with no User-Agent ([FD-8](#fd-8-smaller-request-format-quirks)). |
| **Rate limits** | None hit. Per box: one socket, one REST read per minute, two REST reads per reconnect. | None hit. Per box: one SMP poll per second, one PIR socket, a board refresh (two requests) every 30 s. |
| **Credentials** | Socket `jwt`: DK's site sends `"default-token"`, and DK accepts anything today. Fallback: DK's anonymous JWT. | `_ak` on sbapi, and the PIR client key: public, in FD's web bundle. Re-read from the live bundle if FD rotates them. |
| **Cookies, logins** | None. | None. |

- **"None hit"** means no 429 or other rate-limit response in any run: development, the live recordings,
  or either box's service log since deployment. Rates per box are fixed (Key decision 22).
- **When a book refuses us** (401/403/429), the refused channel backs off up to 30 s, doubling to 10
  minutes (honouring `Retry-After` on HTTP answers), and the book is reported blocked. The second feed
  box, on another IP, keeps the board fed.

### Cookies, tokens and sessions: what expires, and how we recover

> The brief: *"If your solution depends on a cookie, token or session, what happens when it expires,
> and how does your system recover without a human?"*

**Short answer.** Nothing we use is tied to a login, cookie or session, and nothing we use expires today.
Two things could still change without warning:
- FanDuel can rotate its two public keys with a deploy.
- DraftKings could start checking the socket token it ignores today.

Each is detected by its exact failure signature and recovered automatically, with no restart and no
human. While FanDuel recovers, its prices keep flowing through the keyless poll. DraftKings is live again
within a second.

| What we depend on | Lifetime | What failure looks like | How we recover, without a human | Verified |
|---|---|---|---|---|
| **FD `_ak` app key** (board and in-play discovery). Public, in FD's web bundle. | No expiry; FD could rotate it with a deploy | `{"error":true}` with 404 (board), 500 (in-play), or 400 if missing | Re-read FD's live bundle (`/sw.js` → `/static/js/main.<hash>.js`), take every candidate from its key maps, adopt the first one the live board accepts, and retry discovery at once. Known markets keep pricing meanwhile: SMP needs no key, and PIR doesn't use `_ak`. | Live, started with a wrong key: the current key was adopted 0.95 s after start |
| **FD PIR client key** (AppSync push). Public, in the same bundle's AppSync config. | Same | `connection_error` with `UnauthorizedException` (401) | The same bundle re-read. A candidate is valid unless AppSync answers 401. Push reconnects with it at once. SMP keeps prices at 1 s meanwhile, with the book shown `degraded` and the reason. | Live, started with a wrong key: push connected 1.1 s after start, board `live` |
| **DK socket `jwt`.** The literal `"default-token"` DK's site sends. | Not checked today: DK subscribed `"default-token"`, a real JWT, a garbage string, and no `jwt` at all | An error frame, an unsubscribe right after subscribing, or close `4000` (DK's own table: "insufficient params … such as jwt") | After two refusals in a row, switch to DK's anonymous JWT from `gaming-us-{st}.draftkings.com/api/wager/v1/generateAnonymousEnterpriseJWT` (no cookies needed). It goes in the socket URL and the subscribe, as DK's client sends it. | Mock that refuses `"default-token"`: live again within 0.7 s of the first refusal |
| **DK anonymous JWT** (fallback only) | 120 s (`expiresIn`) | Same refusal signals | Renewed at 90% of its lifetime, with 3 tries 2 s apart: DK's own token manager uses this schedule. A refusal fetches a fresh token before reconnecting; other reconnects reuse the current one, so they cost no extra round trip. | Live from box A: token in 0.3 s, then live 410 ms after connecting. A JWT socket and a default-token socket received identical frames over 25 s. |

- **Cookies.** Akamai and PerimeterX set cookies, but we never store or send them, and every endpoint
  we use works without them.
- **Connections are the only "sessions".** AppSync's keepalive window is 5 minutes, and DK closes a
  socket idle for 5 s (`4002`). Any close or 12 s of silence triggers a reconnect, the first within
  250 ms (DK's `4001`/`1013` wait ≥5 s; refusals back off from 30 s). DK re-snapshots on reconnect; FD's
  poll covers the gap. See
  [Reliability](#reliability-staying-up-and-honest-when-not).

**Guard rails**
- **A block is never mistaken for a rotated key.** Detection matches the exact signature (a WAF block is
  a 403 HTML page), and blocks get their own 30 s → 10 min backoff.
- **FD's bundle is re-read at most once per 5 minutes** (30 s after a download that failed outright).
  It is 4.6 MB of JS, ~1.4 MB gzipped.
- **The status says what's wrong,** e.g. `degraded: push key rejected (UnauthorizedException); refreshing keys`.
- **Learned keys live in memory.** After a restart, the first rejection repeats the refresh, about 1–2 s.
- **Switching DK to the JWT is permanent for the process.** The JWT is what DK's own widgets use, so
  staying on it is safe.

**What would still need a human**
- **FD restructures its bundle** so the extractor finds no working key. The status keeps saying the key
  is rejected, and the log says `bundle keys match ours or none validated`; the extraction pattern needs
  updating.
- **Either book puts its APIs behind an interactive challenge,** such as PerimeterX on FD's API hosts or
  an Akamai sensor check on DK's REST. We don't solve challenges, by design. The second box on another IP
  covers a per-IP block, and a proxy is the last resort.
- **DK requires a logged-in user's token for odds.** That needs an account, which we deliberately avoid.

**Watch it happen:**
```bash
FD_APP_KEY=wrong FD_PIR_KEY=wrong npm run watch:fd   # fetches FanDuel's current keys from its bundle
DK_TOKEN_MODE=anonymous-jwt npm run watch:dk          # DraftKings on its anonymous JWT (needs an IP DK accepts)
```

---

## Reliability: staying up, and honest when not

Each failure we could script was run against the real connector code. DraftKings scenarios used a local
server that speaks DK's protocol: it serves a real DK snapshot from public captures and sends DK-format
update frames (the harness isn't in the repo yet; see [What we'd do next](#what-wed-do-next)). FanDuel's
merge used a live recording, and FanDuel's key recovery and DraftKings' JWT mode were also run live.
Times are from those runs.

| Failure | DraftKings behaviour | FanDuel behaviour | Verified |
|---|---|---|---|
| Socket silently dies (half-open TCP, stalled edge) | 1 s watchdog, ping every 5 s, terminate after 12 s of silence, reconnect | Same. AppSync pongs arrive ~1 s late and its keepalive comes every 60 s, which is why the limit is 12 s | DK: detected **12.1 s** after the last message (was 45–60 s); live again **0.2 s** later |
| Server closes the socket | First retry within 250 ms, exponential to 30 s; `4001`/`1013` wait ≥5 s; a `4000` counts as a token refusal (see the credential row) | First retry within 250 ms, exponential to 30 s | DK: close 1011 → reconnected in **154 ms**, live ~0.1 s later |
| Socket alive but subscription silent | Resubscribe (make-before-break) after 45 s without update frames while games are live, or when a reconcile corrects ≥3 quotes | New subscription sets replace old ones only after acknowledgement; failures retry with backoff | DK: a reconcile correcting 192 quotes triggered a resubscribe |
| REST/board unavailable | Cold start retries 1 s → 10 s. After a reconnect, the last board keeps updating from live deltas as **`degraded`** (if we were live within 2 min) | Discovery retries 2 s → 30 s; prices keep flowing via push and poll | DK: `degraded` within **0.3 s**, deltas kept applying; back to `live` **0.1 s** after REST recovered |
| Bad read: empty, partial or error page | Malformed snapshots rejected. Dropping >30% of the games (with ≥4 held) needs a read ≥30 s later to agree | Board without attachments rejected; empty SMP answer counts as a failure | DK: two consecutive empty snapshots both held; board intact |
| Blocked (HTTP 401/403/429) | Socket and bootstrap snapshot back off up to 30 s, doubling to 10 min (`Retry-After` honoured on HTTP answers); the 60 s reconcile keeps its cadence; status says "blocked" | Same for push and for polling, separately; the 30 s board refresh keeps its cadence | Logic; the second feed box on another IP covers it |
| Reconcile racing a reconnect | Connection epoch discards stale async work; an older read never overwrites a newer one | Epoch per push connection | Logic |
| Game ends | Socket `remove.events`; a `FINISHED` status retires the game | Missing from SMP 3 polls in a row → closed, tombstoned 2 min | DK: `FINISHED` removed the game and its 6 quotes |
| A credential is rotated, or starts being enforced | Two refusals in a row switch the socket to DK's anonymous JWT, renewed at 90% of its 120 s life | A rejected key (exact signature) triggers a re-read of FD's live bundle; the key FD accepts is adopted and push reconnects. SMP keeps prices flowing meanwhile | FD live, both keys wrong: keys adopted in **0.95 s**, live at 1.16 s. DK mock: live again within **0.7 s** of the first refusal |
| A consumer listener throws | Isolated per listener, counted in `listenerErrors` | Same | Logic |
| One host's IP blocked by a book | Second feed box on a different IP; the board keeps the first copy | Same | Architecture |

**Status semantics** (what the UI shows):
- **`live`:** data is flowing and confirmed fresh.
- **`degraded`:** data is still flowing but something is impaired, e.g. one FD channel down, or DK
  updating on its last board while REST is out.
- **`down`:** no current data, so the book is marked stale.

`lastDataAt` is refreshed by any frame, pong, keepalive or successful poll. On a quiet board it still
proves freshness every ≤5 s.

---

## Normalization and matching

- **Shared shape.** Every book maps into
  `Quote {book, gameKey, market: moneyline|spread|total, side: home|away|over|under, line, american, decimal, suspended, live, bookTime, receivedAt, channel}`.
- **Game key: `YYYY-MM-DD(ET):AWAY@HOME`.** Books disagree on kickoff by a minute (FD 00:16Z vs DK
  00:15Z for the same game), and no NFL game starts near midnight ET, so the Eastern calendar date is
  stable where the timestamp isn't.
- **Team names.**
  - The books spell teams differently: FD "Washington Commanders", DK "WAS Commanders" (and DK's
    `rosettaTeamName` "Commanders").
  - Abbreviations are ambiguous ("NY Giants"/"NY Jets", "LA" vs "LAR").
  - All 32 NFL nicknames are unique single words, so labels resolve by their **last word**.
  - Labels containing parentheses are rejected. Real NFL listings never have them, while simulated
    eFootball games do ("Detroit Lions (CLOCKWORK)"), so a fake game can't claim a real game key.
- **Sides and lines.**
  - FD runners carry `result.type`; DK selections carry `outcomeType`. No name matching is needed.
  - The spread `line` is the side's own handicap (away +7.5, home −7.5) in both books. The total `line`
    is the total.
- **Odds.**
  - DK renders negative American odds with a **U+2212 minus** (`"−110"`), which `Number()` can't parse.
  - FD's two channels report decimals at different precision (1.869565… vs 1.87), so "did the price
    change" compares American price, line, suspension and live flag, never the decimal.
  - A decimal ≤ 1 is never turned into a price; it would otherwise become ±Infinity.
- **Main lines only.** FD's board lists one main market per type per game. DK's subcategory 4518 is main
  lines, preferring the `MainPointLine`/`main` selection while a move is mid-flight.
- **Best price across different lines** follows rules R1–R5: see [Best price](#best-price).

---

## The board: two feeds, one view

Box A runs the board; Box B is a second, independent feed on a different IP (see
[Architecture](#architecture)). Both boxes run both connectors. Box B streams its connectors' events to
Box A as newline-delimited JSON over a private TCP link (port 7070, open only to Box B's security group,
token-checked). The link measured **p50 1 ms / p90 13 ms** one-way in its first run; on 2026-10-19
`/api/metrics` showed p50 0 / p90 1 / p99 3 ms over 4,356 samples. After a reconnect Box B sends a full
snapshot instead of replaying a backlog.

**Merging (`src/server/feedMerge.ts`).** The board consumes every channel's observations (the connectors'
`sample` events) from both boxes: A:push, A:poll, B:push, B:poll and so on. Each quote is a `QuoteMerge`:
- **First copy wins.** A new state is shown the moment any channel of any box delivers it.
- **Never backwards.** Precise reports (polls, snapshots, DK's millisecond `createdTime`) are ordered by
  time against the last moment the shown state was known to be in effect. FanDuel's push timestamps are
  whole seconds, too coarse to order changes inside a second, so a push channel's report is matched to
  the first occurrence of that value after the channel's last position (push channels deliver every change
  in order); a late copy of a state already passed is rejected.
- **One observation, one judgment.** A box reports each observation twice, as a `sample` and as a
  `change`; a feed repeating the state it last reported is that second delivery and never moves the board.
- **Heal and fail over.** A once-a-second sweep adopts a state every healthy feed has agreed on for 3 s,
  and switches a quote to the freshest healthy feed when its feed goes unhealthy.

**Evidence.**
- Simulation, 400 seeded runs with bursts and dropped push frames: **0 rollbacks**; all runs converge;
  ~3% of FanDuel states shown late (p50 224 ms, p90 524 ms: an ambiguous push held until a poll proves it).
- Real data, replaying 180 s of live FanDuel (70 in-play markets, 2,910 channel reports; `npm test` runs
  it): **1,544 states shown, 0 flips, 633 of 1,378 shown before push delivered them (mean 274 ms
  earlier), 2 shown late (595 ms).** Push alone would have shown 312 states late (p50 235 ms).
- Two designs failed in simulation and were removed: blocking any previously seen value (delays genuine
  reversals in oscillating prices) and "this feed is in sync, accept its next change" (polls make the
  board skip states, so value matching can't prove sync: 31–69 rollbacks).

**Staying honest (`src/server/board.ts`).**
- A book is **stale only when every feed for it is stale**, and only after a 5 s grace (a normal DK
  reconnect takes ~0.5 s). Stale books, suspended quotes, pregame quotes on a live game and games flagged
  as suspect are **shown hatched but never used for Best Price**.
- **Frozen-feed watchdog:** a feed with no live price changes for 90 s while its peer moves at least 5 is
  excluded and restarted (once per 5 min).
- **Mass-removal hold:** a batch from a healthy feed that removes more than 30% of a book's quotes (and at
  least 12) is held 15 s; quotes re-listed in that time are kept, the rest are then removed.
- **Cross-book sanity:** pregame, books whose no-vig probabilities differ by more than 20 points at lines
  within 1.5 points (likely a mapping error) flag the game; it's excluded from Best Price.
- Handlers never throw back into a connector; `/healthz` is process liveness only, so a blocked book can
  never restart-loop the host. `/api/health` shows every feed, overlay and counter.

**Drills (`npm run drills`, `scripts/drills.ts`).** A board process and a feed process on one machine,
linked over TCP like Box A and Box B, with synthetic books (`src/server/fake.ts` makes prices a function
of the wall clock, so both processes watch one book). Each drill breaks one thing and times what the
board's public API shows. All 11 pass (2026-10-19):

| Drill | Observed |
|---|---|
| Box B crashes (`SIGKILL`) | B marked down in 0.1 s; both books live throughout (0 stale samples in 10 s) |
| Box B restarts | healthy again in 1.9 s; no mass removal held (B snapshots only once its books are live) |
| Box B hangs (`SIGSTOP`) | link dropped after 5.0 s of silence; books never stale; relinked 0.5 s after resuming |
| DraftKings stops on Box A | Box B carries DraftKings: never stale, prices keep moving |
| …and Box B crashes too | DraftKings stale in 0.1 s; 0 of 48 best prices use it; FanDuel unaffected |
| DraftKings returns on Box A | live in 0.3 s; back in 24 best prices |
| Box B's link held 2 s behind | 942 changes in 60 s, all via Box A; no price moved backwards; 0 heals |
| Box B's FanDuel drops 80% of quotes | held 15 s; the board keeps all 48 that Box A still lists |
| Box A's FanDuel sends invalid prices | 79 dropped; none displayed |
| Box B's DraftKings freezes (connected, silent) | flagged by the watchdog 112 s after start, restarted; DraftKings never stale |

The drills found two bugs, both fixed and covered by tests. A feed-link drop never registered as a health
flip (the link flag changed before the health check read it), so a book that lost its last healthy feed
went stale but kept its Best Price picks until an unrelated move: 17 of 48 still named DraftKings 1.5 s
later. And a late copy delivered twice (sample, then change) passed on its second delivery when FanDuel's
whole-second times tied: 20 of 958 changes came from the lagging box. Both could happen in production:
the first whenever Box B's link drops while it carries a book alone, the second whenever Box B's copy of
a FanDuel state lands after Box A has shown the next one from the same second (push latency differs by
hundreds of ms between connections). Both fixes went live before the first live-game measurement.

## Best price

One pure function family (`src/shared/bestPrice.ts`: `compareOdds`, `bestOf`, `getFairProbability`).
Prices are compared by the displayed American price, never a feed's decimal (FD's push and poll report
1.87 vs 1.869565 for the same price).

| Rule | When | Pick | Label |
|---|---|---|---|
| R1 | Moneyline | Higher payout | none |
| R2 | Spread or total on the same line | Higher payout | none |
| R3 | **Pregame** spread on different lines, with a no-vig consensus | Highest **estimated return** per $1 | `est.` |
| R4 | Different lines where no model applies: totals, live spreads, no consensus | **Better line** for the bettor, then payout | `by line` |
| R5 | Equal price on equal terms | Tie: every book listed | none |

- **The model (R3).** Each book's two-sided spread gives a no-vig P(cover); the books are moved to a
  common half-point with an NFL push table and averaged (`getFairProbability`, pluggable: median or a
  sharp-book reference later). Every offer on both sides is then scored as
  `P(win) × decimal + P(push)` against the same anchor, so favorite and underdog picks stay consistent.
- **The push table** (`npm run push-table`): nflverse `games.csv`, 7,368 completed games 1999–2026. For
  each margin k, the share of games with closing spread within ±1 of k that the favorite won by exactly
  k, shrunk toward the all-games rate (weight 300) because the tails are sparse. 3 lands 9.2%, 7 6.1%,
  10 4.4%, 14 4.1%.
- **The brief's example**, DK ±3 −110 vs FD −3.5 +100 / +3.5 −120 (push at 3 = 9%): the favorite goes to
  **DK −3 −110** (est. 0.981 vs 0.933) and the underdog to **FD +3.5 −120** (0.978 vs 0.936).
- **On the live board (2026-10-19, pregame):** PIT@NO had DK −3 −105 vs FD −2.5 −120 for the favorite;
  FD won (est. 0.967 vs 0.943). For the underdog, DK +3 −115 beat FD +2.5 −102 (0.975 vs 0.935). The
  labels say how a pick was made; the odds shown are always the book's actual odds.

## Serving the board: Server-Sent Events

- **SSE, not WebSocket:** traffic is one-way; `EventSource` reconnects by itself and resumes with
  `Last-Event-ID`; it is plain HTTP through any proxy.
- **Snapshot, then deltas.** A client gets a snapshot (or, when resuming, just the deltas it missed),
  then one delta per board change. Event ids are `<boot>.<seq>`: `seq` is consecutive and never skips,
  and a restart (new boot id) always yields a snapshot.
- **No batching delay.** Everything that changes in one event-loop turn is coalesced into one delta
  (`setImmediate`, < 1 ms), serialized once, and the same bytes are written to every client. Nagle is off.
- **Heartbeats** every 5 s carry each book's status and are never ahead of the deltas already sent, so
  a client can detect a gap. The client also watches for 12 s of silence and reconnects.
- **Payload.** A one-market move is ~550 bytes (two quotes with their previous prices, two best-price
  cells; live deltas seen: 370–993 bytes). The full snapshot is ~58 KB uncompressed for a 15-game slate; the stream itself is not compressed (per-client
  compression would undo serialize-once), JSON endpoints are.
- **Slow clients** that buffer more than 1 MB are dropped; they resume or take a snapshot.
- **The edge.** Caddy on Box A (automatic TLS for the Elastic IP's sslip.io name, HTTP/2; it also
  advertises HTTP/3, which needs UDP 443 open to Box A) flushes event streams immediately. There's no load
  balancer or CDN in front, since either can buffer SSE. Checked through the public URL from St. Louis on
  2026-10-19: HTTP/2, stream first byte in 91 ms, `retry: 1031`, heartbeat gaps of 4.5–5.0 s (an earlier
  check, vantage point not recorded, saw a 33 ms first byte).

**Many viewers** (`scripts/load-sse.ts`, from St. Louis to Box A over the internet and TLS, against a
board fed by synthetic books; clock error ±16 ms):

| Viewers | Board update rate | Per viewer | Failed | Emit → receive p50 / p90 / p99 |
|---|---|---|---|---|
| 50 | ~18 deltas/s | ~20 KB/s | 0 | 19 / 55 / 156 ms |
| 500 | ~18 deltas/s | 19.7 KB/s | 0 | 44 / 158 / 460 ms |
| 2,000 | 5 deltas/s (realistic) | 6.5 KB/s | 0 | 76 / 202 / 872 ms |
| 2,000 | ~18 deltas/s | ~20 KB/s | 0 | 531 ms / 6.5 s / 20 s (saturated) |

One process serializes each delta once, so viewer count costs only socket writes. The saturated run didn't
isolate its bottleneck: ~320 Mbit/s (2,000 viewers × 20 KB/s) is above a `t3.medium`'s ~256 Mbit/s
sustained network baseline, and one load-generator process decrypting 2,000 TLS streams can saturate
too. Past that, the board stays as is and fans out to more edge boxes (each subscribes to the
board's stream once and serves its own viewers), and the payload can shrink (shorter keys, dropping
unchanged `reason` text).

## The UI

- The toggle (**Best Price | DraftKings | FanDuel**) is built from the book list the server sends, so a
  third book needs no UI change. The view is kept in `?view=`.
- **Best view:** the best line and price with the book underneath (both books on a tie), the `est.` or
  `by line` label beside the book name when the lines differ, and the other book's price shown muted.
- **Book views:** that book's prices, with ★ where it holds the best price.
- **Price moves flash** green (better for the bettor) or red, with the previous price struck through for
  5 s. Snapshots, view switches, returning to the tab, reconnect catch-up and eligibility changes never
  flash.
- **Staleness is explicit:** per-book status chips ("live · last move 4s ago · 2 feeds", or "no data
  for 31s" when stale), a banner when a book is down or the stream is reconnecting, and hatched prices
  with the reason ("Not used for Best Price: stale").
- The page measures its own latency (server → browser, book → browser, paint) and sends it to
  `/api/latency`; it is reported in `/api/metrics`, not shown on the page.

---

## Latency: measured so far

**How we measure.**
- Each quote records `bookTime`, the book's own change time: DK `createdTime` (ms) and FD PIR `updatedAt`
  (**whole seconds**, so FD ages carry up to 1 s of truncation). It also records `receivedAt`.
- `sample` events record each channel's own arrivals before cross-channel dedupe, so push and poll can
  each be timed against the other.
- DK frames also carry `publishedTime` and the gateway's `websocketPublishTimestamp`, which splits DK's
  delay into engine, pipeline and network legs.
- Both boxes' clocks follow Amazon Time Sync (169.254.169.123). On 2026-10-19 chrony put box A 0.95 µs
  fast and box B 1.0 µs slow (RMS 2.5 / 1.1 µs). The dev server was checked against Google, AWS and
  FanDuel `Date` headers (±0.15 s).
- Browser-side legs (server → browser, book → browser, paint) are beaconed by every open page to
  `/api/latency` and reported in `/api/metrics`. End-to-end results per book, pregame and live, come from
  `scripts/measure-e2e.ts` (first run: tonight).

**FanDuel, book → backend.**

| Measurement | Result |
|---|---|
| PIR push age at receipt vs `updatedAt` (St. Louis, 180 s, 143 markets) | Raw p10 586 / p50 1035 / p90 1492 ms. `updatedAt` is truncated to the second, so raw is an upper bound: the true p50 lies in (35, 1035] ms. *Estimate (truncation-corrected):* ≈0.5 s. |
| PIR push age vs `updatedAt` (Ohio, 120 s, 70 live markets) | Raw p10 524 / p50 964 / p90 1373 ms, an upper bound in the same way |
| Who shows a change first (Ohio, 337 changes) | push 182 · SMP poll 151 · PIR GraphQL 4 |
| Poll ahead of push, when they differ (Ohio, 297 differing observations) | 288 ahead, by p50 235 ms / p90 460 ms; 0 stale |
| `MarketMerge` vs push alone (Ohio recording) | 45% of new states (312 of 693) shown earlier, by a mean of 249 ms (p50 235 / p90 452 ms) |
| FD's own website (5 s poll) | A poll every P seconds is P/2 stale on average: ~2.5 s at 5 s, against ~0.5 s at our 1 s (~0.25 s with both boxes interleaved) |

- **Cost.** PIR push used 163 KB for 229 frames over 180 s across 143 markets. The SMP poll for 45 NFL
  markets is one ~3.4 KB gzipped request per second.

**DraftKings.**
- Bootstrap from Ohio: live in **250–540 ms**.
- Pings return in ~30 ms.
- Book → backend per frame comes from `createdTime`, `publishedTime` and `websocketPublishTimestamp`. It
  needs a run with real line movement: Monday Night Football tonight is the first chance, pregame and
  live.

**What we did to cut latency:**
- **Push wherever a book has it:** DK socket, FD PIR.
- **Race the uncached FD origin at 1 s,** on wall-clock slots that a second host interleaves at +0.5 s,
  instead of the site's 5 s. Never take prices from the CDN-cached board.
- **Show each FD price from whichever channel has it first,** with push applied in book order. On the
  live recording this produced zero backward moves and zero late states.
- **Overlap startup work:** DK's snapshot runs in parallel with the handshake, and FD's push connects
  during the first discovery.
- **Keep connections warm** (keep-alive), so requests skip TCP/TLS setup.
- **Apply each frame immediately:** no batching in the connectors.
- **Host next to FD's push origin** (`us-east-2`).

---

## Hosting: region, instances and network

**Where the books are**
- **FanDuel's push service:** its own web config names AWS AppSync in **`us-east-2` (Ohio)**.
- **FanDuel's REST hosts:** served by CloudFront. From Ohio the nearest point of presence is `CMH68`
  (Columbus), and the price origin answers as `Cougar`.
- **DraftKings:** sits behind Akamai, which hides the origin. DK's own client config places its API
  gateways in GCP `us-east4` (northern Virginia).

**Measured from AWS `us-east-2b` (our first test instance and box A, same zone) vs the St. Louis dev
VPS** (2026-10-19). We used warm keep-alive connections, and app-level acknowledgements, which travel all
the way to the origin.

| Path | AWS Ohio | St. Louis VPS |
|---|---|---|
| FD PIR socket: `connection_init` → `connection_ack` | **1.3–4.7 ms** | 26–62 ms |
| FD PIR GraphQL request, warm time to first byte | **10–12 ms** (CloudFront `CMH68`) | 57 ms (`ORD58` Chicago) |
| FD SMP price origin round trip, warm | **~12 ms** (`CMH68` → `Cougar`) | 39 ms (`ORD58`) |
| DK socket: `subscribe` → `subscribed` | **35–63 ms** | blocked (403) |
| DK REST snapshot, cold (incl. TLS) | 130–220 ms | blocked (403) |

**Region verdict: `us-east-2` is the right region.**
- It is optimal for FanDuel: the push origin is 1–5 ms away.
- DK's 35–63 ms acknowledgement suggests its origin is farther away, plausibly northern Virginia.
- `us-east-1` might shave ~10 ms of round trip off DK but would add about the same to FanDuel.
- Both are dwarfed by the books' own delays. FD push arrives a raw p50 of ~1 s after its whole-second
  `updatedAt` (≈0.5 s estimated). Public DK captures show tens of ms to over a second between
  `createdTime` and `publishedTime`; our own DK numbers come tonight.

**What we run:**

| | Box A | Box B |
|---|---|---|
| Role | board, website, feed | second, independent feed |
| Instance | `t3.medium` (2 vCPU, 4 GB) | `t3.micro` (2 vCPU, 1 GB) |
| Public address | **Elastic IP** (stable for the site and for DK's IP checks) | auto-assigned (nothing points at it) |
| Inbound | 443/80 from anywhere · 7070 only from box B's security group · SSH (key-only) | SSH (key-only) |
| Egress probe | all five channels OK, re-checked after the Elastic IP was attached | all five channels OK |

- **Network.** Both boxes are in `us-east-2b` in the same VPC. Box B reaches box A's private address on
  TCP 7070, so feed traffic never crosses the public internet.
- **Measured load.**
  - The two connectors alone (the watch harness on box A, before the board was deployed): **140 MB RSS
    and 1.2–1.7% of one core**, event-loop lag p99 0.5 ms.
  - Deployed, in quiet pregame (2026-10-19): the box A process (feed A, board, stream and site) 164 MB
    RSS and under 1% of a core; box B's feed 138 MB and under 1%.
- **Why not `t2`.** A `t2.micro` would cope, but it throttles to a 10% CPU baseline when its credits run
  out, and its single vCPU lets any OS task stall the event loop. `t3` has neither problem at the same
  price.
- **Why a medium.** Box A is a `t3.medium` for headroom: building the frontend on the box, and many
  concurrent viewers.
- **Runtime.**
  - Node 24 LTS runs from the user's home directory: a checksum-verified tarball, no system packages.
  - npm 11's install-script block is left on. Only esbuild's optional postinstall is skipped; its binary
    ships as a platform package.
- **IP changes.** A stop/start or resize changes box B's IP, and would change box A's without the Elastic
  IP. DK access is IP-reputation dependent, so re-run `scripts/probe-egress.mjs` after any IP change.

---

## Issues hit and how we got around them

Each entry lists **symptom → diagnosis → resolution**, plus its current status.

### DraftKings

#### DK-1: Akamai denies every DraftKings host from our dev server
- **Symptom.** `403 Access Denied` (`server: AkamaiGHost`) for:
  - the REST API, the socket upgrade and the HTML site;
  - even `www.draftkings.com` and `api.draftkings.com`;
  - every client tried: curl, Node `fetch`, Python `urllib`, with and without browser headers.

  The server has no IPv6 to try a different path.
- **Diagnosis.**
  - An identical plain "Access Denied" for every client and every DK property points to an
    **IP/ASN reputation block at the edge**. Our VPS is a Contabo datacenter IP (AS40021).
  - `cdn.draftkings.com` (static assets) was *not* blocked.
- **Resolution.**
  - Built the connector without network access to DK: read DK's own client library from
    `cdn.draftkings.com`, plus the Wayback Machine's 2026-10-05 capture of the NFL page and its bundles.
  - Validated it against a local replay of real DK socket frames from public September 2026 captures.
  - Added proxy support per channel.
  - Wrote `scripts/probe-egress.mjs` to qualify hosts. AWS EC2 in `us-east-2` passes all five channels,
    even though third-party reports said AWS IPs fail DK's REST host.
- **Status: resolved by hosting on AWS `us-east-2`.**

#### DK-2: the archived page came back as DraftKings Alberta
- **Symptom.** The Wayback capture was DK's **Alberta** site (`dkcaab`, `sportsbook-ws-ca-ab`).
- **Resolution.** US equivalents (`dkus{st}`, `US-{ST}-SB`, `sportsbook-ws-us-{st}`) come from a
  hard-coded US-WV config inside the same client bundle. NFL ids come from the capture's nav tree:
  league 88808, Game Lines category 492, subcategory 4518.

#### DK-3: the production socket speaks MessagePack with positional arrays
- **Resolution.** `format=json`: the same frames, self-describing. See
  [Key decision 3](#key-decisions).

#### DK-4: the socket wants a `jwt`
- **Finding.** DK's site sends the literal string **`"default-token"`**, and the socket checks nothing.
  `"default-token"`, a real anonymous JWT, a garbage string and no `jwt` at all were all subscribed
  (tested from box A, 2026-10-19).
- **Risk.** DK could start enforcing it. DK's own widgets already fetch an anonymous enterprise JWT
  (`generateAnonymousEnterpriseJWT`: no cookies, `expiresIn` 120 s) and renew it at 90% of its life.
- **Resolution.**
  - The connector sends `"default-token"` and falls back to that JWT after two refusals in a row. It
    sends and renews the JWT the way DK's client does: in the URL and the subscribe, renewed at 90%.
  - Verified against a mock that enforces tokens: live again within 0.7 s of the first refusal.
  - Verified live in JWT mode: identical frames to the default token, side by side.
  - See [Cookies, tokens and sessions](#cookies-tokens-and-sessions-what-expires-and-how-we-recover).
- **What testing caught.** In the first mock run, the switch to the JWT was followed by a 30 s wait: a
  `4000` close carried a 30 s floor even though the retry would send a new token. A `4000` is now a token
  refusal with no floor, so it retries on the normal backoff. The run also counted one connection's
  refusal twice (its error frame and its `4000` close); refusals now count once per connection.

#### DK-5: deltas only, with partial objects and no sequence numbers or replay
- **Resolution.** Full client-side state, the parallel bootstrap with buffered replay, a 2 s resync, and
  a 60 s reconcile with a 10 s trust window.

#### DK-6: line moves are remove-then-add, with changes sometimes before the add
- **Resolution.** Key quotes by (game, market, side); hold orphan changes 10 s; give a side 1 s grace
  before removing it.

#### DK-7: American odds use U+2212
- **Resolution.** A dedicated parser.

#### DK-8: REST omits `isSuspended` when false
- **Resolution.** Snapshot entities **replace**; only socket `change`s merge. Merging would keep a stale
  `true` alive.

#### DK-9: DK's close-code semantics
- **Finding.** In DK's own close-code table, `4002` means "connection inactive for 5000 ms", `4000`
  ("insufficient params … such as jwt") is terminal, and `4001`/`1013` want ≥5 s.
- **Resolution.** Subscribe on open, and wait ≥5 s after `4001`/`1013`. A `4000` is handled as a token
  refusal rather than a dead end: normal backoff, and a second one in a row switches the socket to the
  anonymous JWT ([DK-4](#dk-4-the-socket-wants-a-jwt)).

#### DK-10: Akamai scores the client, not just the IP
- **Finding.** From the same accepted AWS IP:
  - Node's `fetch` gets **200**.
  - A bare `https.request` (fewer default headers) gets **403**.
- **Resolution.** All DK HTTP goes through Node's `fetch`, and the egress probe uses the same client, so
  a passing probe predicts the connector. Re-run the probe after Node upgrades.

#### DK-11: finished games counted as live
- **Found in review.** `live` was "any status but `NOT_STARTED`", which included `FINISHED`.
- **Resolution.** DK's enum (from its bundle) is exactly `NOT_STARTED` / `STARTED` / `FINISHED`. Live
  means `STARTED`; `FINISHED` retires the game. Verified in the replay harness.

#### DK-12: a reconcile in flight across a reconnect could overwrite the newer bootstrap
- **Found in review.**
- **Resolution.** A connection epoch: work started under an older connection is discarded, and a REST
  read older than the last applied one is ignored. Socket handlers of a replaced socket are also no-ops,
  so a late `close` can't reset the new connection.

#### DK-13: an empty or partial snapshot could wipe the board
- **Found in review.** A `200` with no events would have removed every game until the next reconcile,
  up to 60 s.
- **Resolution.**
  - Snapshots missing the entity lists are rejected.
  - A drop of more than 30% of the games (with 4 or more held) needs a read ≥30 s later to agree.
  - The first version required only the *next* read to agree; the replay harness showed two back-to-back
    empty reads could still blank the board, hence the time requirement.

#### DK-14: dead sockets went unnoticed for up to a minute
- **Found in review.** 15 s pings with a 45 s limit.
- **Resolution.** 5 s pings with a 12 s limit on a 1 s watchdog. Measured: detected at 12.1 s, live again
  0.2 s later.

#### DK-15: REST is the only bootstrap path
- **Found in review.** We tested `initialData: true` from box A: DK sends only the acknowledgement (the
  first update came 53 s later), so there's no socket-only bootstrap.
- **Resolution.**
  - After a reconnect, the last board keeps updating from live deltas as `degraded` while the snapshot
    retries (1 s → 10 s; 30 s → 10 min if blocked).
  - A cold start waits for REST.
  - The second feed box covers a REST block on one IP.

#### DK-16: pongs prove the socket, not the subscription
- **Found in review.**
- **Resolution.** Resubscribe (make-before-break) when live games see no update frames for 45 s, or when
  a reconcile has to correct ≥3 quotes.

#### DK-17: the jurisdiction name is ignored, so we cannot choose a DraftKings region
- **Symptom.** `DK_STATE=nj` looked like it selected New Jersey prices.
- **Finding (measured 2026-10-19 from AWS Ohio, US-east-1 and Canada).**
  - REST: `…/sportscontent/{site}/v1/leagues/88808/…` returned the same bytes for `dkusnj`, `dkcaon`,
    `dkcaab` and a made-up `zz`, from all three locations (same hash, 15 events, 90 selections).
  - Socket: every `sportsbook-ws-{us-nj,us-pa,ca-on,ca-ab}` host and every `siteName` (including `zz`)
    acknowledged the subscription, and the same market (`1_84695442`, NO Saints +136) updated under
    `dkcaab` and `zz` alike. Market ids carry no jurisdiction prefix.
  - Nothing in the response, headers or cookies names a jurisdiction. The legacy `/sites/US-NJ-SB/…`
    path is `403 Access Denied` for every site, including NJ.
- **Resolution / status.** Unresolved. We get one DraftKings feed whatever we ask for, and cannot tell
  which jurisdiction it represents, so "DK prices are NJ" is **not verified** (D-03 says it is).
  `scripts/probe-egress.mjs` reports "OK" for any state name because it checks status codes only, not
  that the data differs.

### FanDuel

#### FD-1: PerimeterX (HUMAN) blocks the HTML site from our datacenter IP
- **Resolution.** We never need the HTML. The API hosts answer normally. To read the app's JavaScript,
  non-HTML paths (e.g. `/sw.js`) return the app shell without the PerimeterX check, and `/static/js/*`
  downloads normally.
- **Risk.** FD could extend PerimeterX to the APIs. That would surface as `blocked`/`down`.

#### FD-2: the board endpoint is a CDN cache
- **Finding.** `max-age=30, stale-while-revalidate=60`.
- **Resolution.** Discovery only; prices come from SMP and PIR.

#### FD-3: market ids are per-state namespaces
- **Finding.** Missouri `729.x`, New Jersey `734.x`. Also measured: PA `742.x`, NY `736.x`, IL `717.x`,
  MI `726.x`, CO `708.x`, TN `747.x`. Prices are not per-state (see [FD-16](#fd-16-every-region-prices-the-games-the-same)).
- **Resolution.** One region drives sbapi, smp and pir.

#### FD-4: "the fastest path the site uses" is polling, but a push channel exists
- **Resolution.** We subscribe to PIR for all NFL main markets *and* poll at 1 s, merged by
  `MarketMerge`.

#### FD-5: PIR `updatedAt` has one-second resolution
- **Resolution.** Ages are reported with that caveat. The ordering guard uses `<`, so equal-second
  frames still apply.

#### FD-6: two channels, two decimal precisions
- **Resolution.** Change detection keys on American price, line and status.

#### FD-7: racing push and poll needs rules, and the first rules were wrong
- **Found in review.** A poll answered by a lagging replica could roll back a pushed price, because the
  timing guard only checked when the request was sent.
- **What we did.**
  - Recorded live traffic and replayed it through each candidate rule (see
    [How push and poll are merged](#how-push-and-poll-are-merged)).
  - SMP never served a stale read in 297 differing observations.
  - A rule blocking re-shown states delayed 35 real reversals.
  - A rule holding push behind a poll lead delayed 10 states by ~0.6 s.
  - The old timing guard never triggered.
- **Resolution.** `MarketMerge`: push in `updatedAt` order; otherwise first channel wins. It measured
  zero flips and zero late states.
- **Regression test.** The recording and `scripts/replay-merge.ts` are in the repo, so any change to
  either merge is re-measured against the same data.

#### FD-8: smaller request-format quirks
- The WAF blocks requests with **no User-Agent** (403); we always send one.
- `/in-play` without `eventTypeId` returns `400 {"error":true}`.
- `_ak` is required on sbapi.

#### FD-9: geography
- Reading is not geofenced per state: a Missouri IP reads NJ prices.
- **Not geofenced by country either (measured 2026-10-19).** An AWS Canada (Montréal) instance and an AWS
  US-east-1 instance got byte-identical board responses from `nj`, `pa`, `ny`, `il`, `co` and Ontario, and
  the same live SMP prices. Others' reports that the US API rejects Canadian IPs did not reproduce from
  an AWS Canada address; it may apply to residential or other ranges, which we did not test.
- Edge IPs differ per box (DNS), but the answers do not.

#### FD-10: an empty SMP answer looked like a healthy poll
- **Found in review.**
- **Resolution.** An empty answer to a non-empty request is a failure and does not refresh `lastDataAt`.

#### FD-11: a rejected resubscription could leave push dark for 30 s
- **Found in review.**
- **Resolution.** New subscription sets replace old ones only after every new subscription is
  acknowledged. Failures keep the old set and retry with backoff.

#### FD-12: closed markets lingered and could be re-added
- **Findings.** SMP omits closed markets rather than marking them, and the CDN board keeps listing them
  for up to 90 s.
- **Resolution.** A market missing from 3 consecutive polls is closed and tombstoned for 2 minutes.
  Unknown runner ids trigger an immediate, rate-limited board refresh.

#### FD-13: PIR liveness is slow by design
- **Finding (measured).** AppSync answers WebSocket pings ~1 s late (1002–1019 ms) and sends `ka` only
  every 60 s.
- **Resolution.** Ping every 5 s and treat 12 s of silence as dead (about two missed pongs), instead of
  waiting for `ka`.

#### FD-14: PIR's GraphQL query looked like a timestamped poll source, but it's slow
- **Finding (measured).** It trails push by 1.4 s at p50 and was first on only 4 of 337 changes.
- **Resolution.** Not used. SMP stays the poll source.

#### FD-15: FanDuel's keys can change with a deploy
- **Finding (measured).** A rejected `_ak` gets `{"error":true}`: 404 from the board, 500 from in-play,
  and 400 if missing. A rejected PIR key gets `connection_error` with `UnauthorizedException` (401). A
  WAF block looks different (a 403 HTML page), so the two can't be confused.
- **Resolution.** Self-healing keys: on that exact signature, re-read FD's live bundle, extract the
  candidates, and adopt the first one the live API accepts. See
  [Cookies, tokens and sessions](#cookies-tokens-and-sessions-what-expires-and-how-we-recover).
- **What the live test caught.** The first run, started with both keys wrong, recovered `_ak` but not the
  PIR key:
  - The AppSync config itself contains `{REGION}`, so a pattern that stopped at the next `}` never
    reached the key. It now scans a bounded window.
  - Validation required a clean GraphQL answer, but AppSync answers an accepted key's query for an empty
    id list with a resolver error. Now only a 401 counts as a rejection, and the query uses a real
    market id when one is known.

  After both fixes: both keys were adopted 0.95 s after start, and push connected 0.17 s later.

#### FD-16: every region prices the games the same
- **Question.** Would an Ontario (or other-state) board show different lines from NJ?
- **Finding (measured 2026-10-19, one pre-game snapshot, from AWS Canada and US-east-1; the results
  matched).**
  - **Reachable regions.** 25 US jurisdictions answer on `sbapi.{st}.sportsbook.fanduel.com`: ar az co ct
    dc ia il in ks ky la ma md mi mo nc nj ny oh pa tn va vt wv wy. The other 26 have no DNS name
    (ak al ca de fl ga hi id me mn ms mt nd ne nh nm nv ok or ri sc sd tx ut wa wi). Canada:
    **`on.sportsbook.fanduel.ca` (Ontario) and `ab.sportsbook.fanduel.ca` (Alberta)** answer; `bc`, `qc`,
    `mb`, `sk`, `ns`, `nb` do not. `.ca` hosts, not `.com`; `smp.` and `pir.` exist for `on` too.
  - **Game lines are identical.** Moneyline, spread and total: 90 of 90 runners match NJ in 12 other
    states, Ontario and Alberta, on the cached board; and 90 of 90 on the live SMP endpoint for PA, NY, IL
    and Ontario.
  - **Game props are identical too.** For Chiefs @ Seahawks the event page returned 8 markets and 17
    selections in NJ, PA, NY, IL, CO, Ontario and Alberta, with no price differences.
  - **What differs is the catalogue and the ids.** Market-id namespaces differ per region (FD-3).
    Market counts: 103 (NJ, most states, Ontario, Alberta), 101 (PA, OH), 96 (NY, VA). The missing ones
    are futures and awards (MVP, Coach of the Year, Number-X overall pick), not game lines.
- **Consequence.** An Ontario column would show the same prices as NJ for what we display, so we did not
  build one. **Limits:** one Monday-night snapshot; we did not test Sunday player props, live markets,
  promos or boosts, or anything behind a login. The probe confirmed the Ontario and Alberta PIR push handshake (`probe-egress.mjs --state on|ab`).
- **Latency (median of 6, warm).** From AWS Canada: FD NJ board 17 ms, FD Ontario board 15 ms, DK REST
  46 ms. From US-east-1: 17, 18 and 87 ms (DK min 30 ms). Server location did not change the answers.

### Both books

#### X-1: neither book agrees on names or kickoff times
- **Resolution.** Nickname resolution plus an ET-date game key.

#### X-2: terms of service
- **Finding.** Both books' terms prohibit automated access.
- **What we do.**
  - Read only public, logged-out endpoints the sites themselves call.
  - Use no credentials and no challenge solving.
  - Run one ingestion per book per feed host at modest rates: FD 1 poll/s plus one socket; DK one socket
    plus one REST read per minute.
  - Back off hard when refused.

#### X-3: a throwing consumer could crash ingestion
- **Found in review.** Events were emitted synchronously from socket and poll handlers.
- **Resolution.** Each listener runs in its own try/catch, and failures are counted.

#### X-4: simulated games resolve to real teams
- **Finding.** FD's in-play feed lists eFootball games such as "Detroit Lions (CLOCKWORK) @ Philadelphia
  Eagles (ENFORCER)" (competition "eFootball H2H GG League 4x4mins").
- **Resolution.** The exact `NFL` competition filter already excluded them. As defence in depth, labels
  with parentheses no longer resolve to a team.

#### X-5: the probe and the connector used different HTTP clients
- **Found in review.** Akamai scores the client (DK-10), so a passing probe didn't prove the connector.
- **Resolution.** Both use Node's built-in `fetch`; the connector adds an undici 7 dispatcher, matching
  Node 24's bundled undici.

#### X-6: odds edge cases
- **Finding.** `decimalToAmerican(1)` returned −Infinity.
- **Resolution.** Decimals ≤ 1 now yield no price.

### The board, the feed link and hosting

#### B-1: a dropped feed link left a stale book in Best Price
- **Found by the drills** (`npm run drills`). With DraftKings stopped on Box A, Box B's link then dropped:
  DraftKings went stale, but 17 of 48 best prices still named it 1.5 s later.
- **Diagnosis.** The link handler set `linked` before the health check read "was healthy", so the drop
  never counted as a health flip and those markets' best prices weren't recomputed.
- **Resolution.** The health check applies the change itself (board test added). Deployed 2026-10-19,
  before the first live-game measurement.

#### B-2: a late copy delivered twice could put an old price back
- **Found by the drills.** With Box B's link held 2 s behind, 20 of 958 displayed changes came from B:
  older FanDuel prices, shown again for about half a second.
- **Diagnosis.** Each box reports an observation twice (the connector's `sample`, then its `change`). The
  first delivery was matched as a late copy, which moved B's position past it; the second then matched
  nothing and, with FanDuel's whole-second times tied, passed as new.
- **Resolution.** A feed repeating the state it last reported is a duplicate (Decisions.txt D-35).
  Merge test added; the live replay is unchanged; the drill shows 0 of 942. Deployed 2026-10-19.

#### B-3: a restarting Box B looked like a mass removal
- **Finding.** Box B sent its snapshot before its connectors had bootstrapped; the empty snapshot read
  as "every quote removed", and the mass-removal hold fired.
- **Resolution.** B sends a book's snapshot once that connector is live (15 s fallback), and only a
  healthy feed's removals can trigger the hold. The restart drill holds nothing.

#### B-4: resync snapshots skewed the race statistics
- **Finding.** Snapshot copies keep their original receive times, so they counted as second copies:
  "second-copy lag" read ~119 s, and Box B appeared to win every first copy.
- **Resolution.** The snapshot channel is left out of first-copy, second-copy and processing statistics.

#### B-5: merge rules that failed in simulation
- **Finding.** The 400-run two-feed simulation rejected several orderings: comparing a report's latest
  possible time with the shown state (6 DraftKings and 935 FanDuel rollbacks); ordering by in-effect time
  alone (0 rollbacks, but FanDuel changes from the same second waited for a heal: p90 4 s late); "this
  feed is in sync, accept its next change" (31–69 rollbacks); and position matching applied to polls (2).
- **Resolution.** The shipped rules ([The board](#the-board-two-feeds-one-view), D-35): 0 rollbacks in
  simulation, 0 flips on the live replay.

#### B-6: a space in the install path broke file paths
- **Finding.** `new URL(…).pathname` percent-encodes spaces, so the static-site directory and the test
  alias pointed at `Betstamp%20Technical/…`.
- **Resolution.** `fileURLToPath` everywhere.

#### B-7: `/api/health` showed Box B's private address
- **Found in review.** The feed-link status in the public health payload included B's VPC address.
- **Resolution.** Removed from the payload (the logs keep it). Deploy hosts and addresses live in
  gitignored files and `/etc/odds/`; no public endpoint shows an address (checked 2026-10-19).

#### B-8: healthy feeds said "data overdue"
- **Finding.** A book's chip showed "live, data overdue" while its feeds were fine.
- **Resolution.** The detail appears only when the book is stale.

#### B-9: the load generator was the bottleneck
- **Finding.** One Node process reading 500 TLS streams reported p99 1.1 s; split over 4 processes, the
  same load measured p99 460 ms.
- **Resolution.** `scripts/load-sse.ts --out` merges several processes. The saturated 2,000-viewer run
  still didn't isolate its bottleneck ([Serving](#serving-the-board-server-sent-events)).

#### B-10: two fake feeds were two different books
- **Finding.** Each synthetic-book process walked its own prices, so a second fake feed was another book
  lagging by its start time, and the board flip-flopped between them.
- **Resolution.** Fake prices are a function of the wall clock (D-40); a test checks that a feed started
  later reports the same prices at the same book times.

---

## What we'd do next

**Next up**
- **Measure live NFL latency** tonight (WAS @ SF, 8:15 pm ET), pregame and live:
  - per book and channel, from the `sample` events;
  - DK's engine → pipeline → gateway → us breakdown;
  - end to end through the public URL (`scripts/measure-e2e.ts`).

**With more time**
- **Alerting for the cases that need a human.** Page someone when a book stays `down` for minutes, or a
  key refresh adopts nothing (see
  [what would still need a human](#cookies-tokens-and-sessions-what-expires-and-how-we-recover)).
- **Fixture-based tests for FanDuel's lifecycle.** Mock PIR and SMP the way the DK replay harness mocks
  DraftKings. Commit both harnesses with our own recorded frames.
- **A third book, or ten.**
  - Each book is a translator over the same `BookConnector` base, and the reliability machinery
    (liveness, backoff, status, samples, safe dispatch) is shared or mirrored.
  - The repetitive part (finding endpoints, mapping fields, team names) is where AI tooling helps: point
    an agent at a site's bundle and network capture, and have it draft the connector and a replay
    fixture, which humans review.
- **More coverage.** Alternate lines and props: FD's event page carries `ALTERNATE_HANDICAP` /
  `ALTERNATE_TOTAL` with the line inside the runner name; DK has alternate-line subcategories
  13195 / 13196.
