# Key concepts: short answers

One answer per concept in the brief. Numbers are from the [README](README.md); the live board is at
https://18-227-249-43.sslip.io.

---

## 1. Speed and latency: how old is the number on the screen?

**Measured (book → our backend → browser).** Game night, WAS @ SF, 2026-10-19, ~86 minutes live, every
frame, from the board on AWS. FanDuel's timestamps are whole seconds, so its figures are upper bounds.

| Book | Phase | p50 | p90 | p99 |
|---|---|---|---|---|
| DraftKings | pregame | 73 ms | 1.4 s | 4.6 s |
| DraftKings | live | 1,186 ms | 2.5 s | 7.1 s |
| FanDuel (push) | pregame | 1,042 ms | 1.5 s | 1.6 s |
| FanDuel (push) | live | 968 ms | 1.4 s | 1.8 s |

- **Book → client, end to end (full game, 220 min, through the public URL):** DraftKings live p50 485–691 ms,
  p99 3.4–4.6 s (n = 5,025); FanDuel live p50 539–950 ms, p99 1.1–1.4 s (n = 372, upper bounds). Ranges
  span the two feed boxes.
- **Our share:** feed box → client p50 27–30 ms (p99 ≤ 70 ms), board processing ≤ 2 ms, paint 1–10 ms.
- **Where DraftKings' time goes:** live, engine → publish is p50 1,097 ms (inside DK), gateway → us is
  19 ms, and our processing is ~1 ms. The wait is DK's pricing pipeline, not our network or code.
- **Limits:** one game. The book → backend numbers come from the board on AWS; the end-to-end numbers
  come from one client on the St. Louis dev server, not a Canadian vantage point.

**What we did to bring it down, and why**
- **Get data out of each book the fastest way the book offers.** DraftKings: its own WebSocket delta feed.
  FanDuel: its push channel (PIR) plus a 1 s poll of the uncached price origin, instead of the site's 5 s.
- **Snapshots vs deltas.** DraftKings sends a snapshot then deltas, so we fetch the snapshot in parallel
  with the socket handshake (live in 0.25–0.55 s instead of ~2 s) and apply each frame as it arrives.
  FanDuel sends full market state each time, so we diff it ourselves and emit only real changes.
- **Push to the browser: Server-Sent Events.** Traffic is one-way, `EventSource` reconnects by itself and
  resumes from the last event id, and it's plain HTTP through any proxy. A client gets a snapshot, then
  one delta per change.
- **Payload: small deltas.** A one-market move is ~550 bytes; the full 15-game snapshot is ~58 KB. Each
  delta is serialized once and the same bytes go to every viewer, so the stream isn't compressed
  (per-client compression would undo that).
- **Batching vs immediate: immediate.** The connectors don't batch. The server only merges what changes
  within one event-loop turn (under 1 ms) into one delta.
- **Hosting: next to the books.** AWS `us-east-2` puts FanDuel's push origin 1–5 ms away (26–62 ms from
  St. Louis). DraftKings' Akamai blocks our St. Louis dev server, so AWS was needed anyway.
- **Startup and connections:** startup work overlaps, and keep-alive connections stay warm.
- **Tried and rejected:** other DraftKings subscriptions (single event, no market filter, live-only). None
  beat the one we use on a live game.

## 2. Getting the data

The two books get odds to the browser in very different ways. We use the same paths their own sites use.

| | DraftKings | FanDuel |
|---|---|---|
| **Source** | REST snapshot of the NFL board, then a JSON-RPC WebSocket that streams `add` / `change` / `remove` | Board page for discovery; `getMarketPrices` (SMP) for prices; an AppSync GraphQL WebSocket ("PIR") for push |
| **What each message is** | A delta | A market's full state |
| **What we run** | Snapshot + socket, reconciled against REST once a minute | PIR push and a 1 s SMP poll, per market, showing whichever channel has a new state first |
| **Why** | The socket is the fastest path the site has; REST is edge-cached for 1 s | The site polls every 5 s (~2.5 s average staleness), but its bundle also carries a push channel. Push alone misses changes the poll catches; the poll alone is slower |

The FanDuel numbers behind the choice (replay of a live session, 773 price states): push + 1 s poll is the
reference; push alone is a mean 102 ms behind and misses 1.4% of states; the 1 s poll alone is 147 ms
behind; the site's 5 s poll is 1.8 s behind and misses 16%. The 1 s poll costs one ~3.4 KB (gzipped) request
per second per box.

## 3. Auth, geo and bot protection

| | DraftKings | FanDuel |
|---|---|---|
| **Geo** | Not geofenced: AWS Ohio, Ashburn and Montréal got the same events and prices. Every site name we tried (even a made-up one) returned the same events and prices, so we can't say which region they represent. | Region is chosen by hostname; 25 US states plus Ontario and Alberta answer. Game lines were identical to NJ in every region we compared, so we ship NJ. |
| **Bot protection** | Akamai. It blocked our dev server by IP reputation and scores the HTTP client too (`fetch` gets 200 where `https.request` gets 403 from the same IP). We use AWS IPs, one HTTP client, and a probe (`scripts/probe-egress.mjs`) before any host goes live. | PerimeterX on the HTML site only; the API hosts answer normally. Requests with no User-Agent are rejected. |
| **Rate limits** | None hit. A stepped test from the t3.micro went up to 10 req/s on the REST snapshot with no refusals. | None hit. The same test went up to 20 req/s on SMP prices (70 markets) with no refusals. |

The rate test (8 s per step, stopped at the first non-200) found no ceiling, so those are floors, not
limits. What blocks us is IP reputation, not location.

**If it depends on a cookie, token or session, what happens when it expires?** Nothing depends on a login,
cookie or session. Two credentials could change, and both recover without a human:
- **FanDuel's keys** are public, in its web bundle. If FD rotates them, the connector re-reads the live
  bundle and adopts the key FD accepts (tested: live again in ~1.2 s). SMP polling needs no key, so prices
  keep flowing meanwhile.
- **DraftKings' socket token** is the literal `"default-token"` its own site sends, and DK accepts it
  today. If DK starts enforcing it, the connector switches to DK's anonymous JWT and renews it on DK's schedule.

If a book refuses us (401/403/429), that channel backs off (up to 10 minutes, honouring `Retry-After`), the
book is reported blocked, and the other book and the second feed box keep the board fed.

## 4. Shape of the data and matching

**One clean model.** Every book maps into `Quote {book, gameKey, market, side, line, american, decimal,
suspended, live, bookTime, receivedAt, channel}`.

- **Games:** keyed `YYYY-MM-DD(ET):AWAY@HOME`. The books disagree on kickoff by a minute, but the Eastern
  date is stable.
- **Teams:** FD "Washington Commanders" vs DK "WAS Commanders". Abbreviations are ambiguous, but all 32 NFL
  nicknames are unique single words, so we match on the last word.
- **Markets and sides:** from each book's own fields (FD `result.type`, DK `outcomeType`), not names. The spread
  line is the side's own handicap in both books (away +7.5, home −7.5).
- **Odds:** compared by the displayed American price, never the decimal (FD's two channels report 1.87
  vs 1.869565 for the same price). DK's U+2212 minus sign is normalized.

**Which book sends what.** DraftKings sends **deltas** (we track the rest of the state). FanDuel sends the
**full state** of each market on every message.

**Best price on different lines** (e.g. −3 −110 vs −3.5 +100):
- Same line: the higher payout wins. Moneyline is the same rule.
- Pregame spreads on different lines: each offer is scored by **estimated return per $1**, using a no-vig
  consensus of both books and an NFL push table (a 3-point margin is ~9% of games), and labelled `est.`.
  On the brief's example, the favorite goes to DK −3 −110 and the underdog to FD +3.5 −120.
- No model available (totals, live spreads): the **better line** for the bettor wins, labelled `by line`.
- Equal price on equal terms: a tie, and every book is listed. The odds shown are always the book's actual odds.

## 5. Backend design

- **One ingestion per book, not per tab.** Each connector owns its connections and emits normalized changes.
  Fan-out happens afterwards: the board serializes each delta once and writes the same bytes to every viewer.
- **Many viewers.** Load test, 500 viewers at ~18 deltas/s: 0 drops, emit → receive p50 44 ms, p90 158 ms,
  p99 460 ms. Slow clients that buffer more than 1 MB are dropped and resume or take a snapshot.
- **Two feed boxes, one board.** Each box runs the same connectors on a separate IP; the board keeps the first
  copy of each change. If one box or IP is blocked, the other keeps the board fed.
- **When a book is down.** Each book reports `connecting` / `live` / `degraded` / `down`, and the UI
  shows stale data as stale instead of quietly showing old numbers.
- **A third book is three edits, not a re-architecture:** a `BookConnector` subclass in `src/books/`, its id in
  `BOOK_IDS`, and one entry in the registry. Config, the board, best price, the stream, the UI and the
  synthetic test books all read the registry, and `test/addBook.test.ts` runs a third book through the board
  with no other change.
