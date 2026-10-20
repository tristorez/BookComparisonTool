# Latency run: mnf-was-sf-stlouis (2026-10-20T03:40:05.451Z)

- Target: https://18-227-249-43.sslip.io
- Vantage point: St. Louis, MO (US, dev VPS)
- Duration: 220 min; 1 stream connection(s); 3277 deltas; snapshot 62040 B; delta p50 971 B, p99 2853 B
- Clock: server − client offset 11.5 ms, error ±14.5 ms (half the best /api/time round trip). Every client-side number carries this error.

### Book → this client (the age of the number on screen when it arrives)

FanDuel rows are upper bounds: its book timestamps are whole seconds, so the true value lies in (raw − 1000 ms, raw]. DraftKings timestamps are exact (ms).

| book | phase | channel | first feed | n | p50 ms | p90 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|---|---|
| draftkings | live | push | A | 2594 | 691 | 1809 | 4570 | 7383 |
| draftkings | live | push | B | 2431 | 485 | 1571 | 3350 | 8859 |
| draftkings | pre | push | A | 28 | 113 | 789 | 789 | 789 |
| draftkings | pre | push | B | 20 | 90 | 196 | 240 | 240 |
| fanduel | live | push | A | 218 | 539 | 1029 | 1077 | 1161 |
| fanduel | live | push | B | 154 | 950 | 1030 | 1404 | 1404 |
| fanduel | pre | push | B | 2 | 983 | 983 | 983 | 983 |

### First receipt on a feed box → this client

Board processing + fan-out + network to this vantage point.

| book | phase | channel | first feed | n | p50 ms | p90 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|---|---|
| draftkings | live | push | A | 2594 | 28 | 35 | 49 | 206 |
| draftkings | live | push | B | 2431 | 29 | 32 | 64 | 196 |
| draftkings | live | snapshot | A | 4 | 37 | 37 | 37 | 37 |
| draftkings | live | snapshot | B | 26 | 30 | 34 | 37 | 37 |
| draftkings | pre | push | A | 28 | 28 | 32 | 34 | 34 |
| draftkings | pre | push | B | 20 | 30 | 36 | 36 | 36 |
| fanduel | live | poll | A | 1041 | 29 | 35 | 64 | 161 |
| fanduel | live | poll | B | 1022 | 29 | 35 | 60 | 112 |
| fanduel | live | push | A | 218 | 27 | 33 | 37 | 39 |
| fanduel | live | push | B | 154 | 29 | 35 | 70 | 70 |
| fanduel | pre | poll | A | 25 | 30 | 34 | 34 | 34 |
| fanduel | pre | poll | B | 22 | 28 | 37 | 37 | 37 |
| fanduel | pre | push | B | 2 | 10 | 10 | 10 | 10 |

### Board emit → this client

Network + TLS edge only.

| book | phase | channel | first feed | n | p50 ms | p90 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|---|---|
| draftkings | live | push | A | 2594 | 28 | 35 | 49 | 206 |
| draftkings | live | push | B | 2431 | 28 | 31 | 64 | 174 |
| draftkings | live | snapshot | A | 4 | 35 | 35 | 35 | 35 |
| draftkings | live | snapshot | B | 26 | 29 | 33 | 35 | 35 |
| draftkings | pre | push | A | 28 | 27 | 31 | 34 | 34 |
| draftkings | pre | push | B | 20 | 29 | 35 | 36 | 36 |
| fanduel | live | poll | A | 1041 | 27 | 33 | 62 | 158 |
| fanduel | live | poll | B | 1022 | 27 | 34 | 58 | 111 |
| fanduel | live | push | A | 218 | 27 | 32 | 36 | 37 |
| fanduel | live | push | B | 154 | 29 | 34 | 70 | 70 |
| fanduel | pre | poll | A | 25 | 29 | 33 | 33 | 33 |
| fanduel | pre | poll | B | 22 | 27 | 35 | 35 | 35 |
| fanduel | pre | push | B | 2 | 9 | 9 | 9 | 9 |

### Server-side series (`/api/metrics` at the end of the run; includes real-browser beacons)

Each series holds its most recent 5,000 samples; `2026-10-20-mnf-was-sf-stlouis.metrics.jsonl` has a snapshot every 15 min.

| metric | book | phase | channel | feed | n | p50 ms | p90 ms | p99 ms | max ms |
|---|---|---|---|---|---|---|---|---|---|
| bookToBrowser | draftkings | live | push | A | 50 | 524 | 876 | 2007 | 2007 |
| bookToBrowser | draftkings | live | push | B | 190 | 510 | 975 | 1846 | 1846 |
| bookToBrowser | draftkings | pre | push | A | 10 | 353 | 798 | 798 | 798 |
| bookToBrowser | fanduel | live | push | A | 10 | 473 | 968 | 968 | 968 |
| bookToBrowser | fanduel | live | push | B | 10 | 972 | 1027 | 1027 | 1027 |
| bookToServer | draftkings | live | push | A | 2501 | 680 | 1790 | 3704 | 7124 |
| bookToServer | draftkings | live | push | B | 2381 | 459 | 1543 | 3335 | 8846 |
| bookToServer | draftkings | pre | push | A | 112 | 85 | 985 | 2693 | 2694 |
| bookToServer | draftkings | pre | push | B | 88 | 72 | 1883 | 6060 | 6060 |
| bookToServer | fanduel | live | push | A | 216 | 514 | 1004 | 1041 | 1150 |
| bookToServer | fanduel | live | push | B | 152 | 913 | 996 | 1374 | 1374 |
| bookToServer | fanduel | pre | push | A | 4 | 973 | 973 | 973 | 973 |
| bookToServer | fanduel | pre | push | B | 6 | 965 | 973 | 973 | 973 |
| browserClockError |  |  |  |  | 44 | 12.8 | 14.9 | 16 | 16 |
| channelBookToServer | draftkings | live | push | A | 5000 | 632 | 1828 | 3704 | 7363 |
| channelBookToServer | draftkings | live | push | B | 5000 | 549 | 1815 | 3502 | 7373 |
| channelBookToServer | draftkings | pre | push | A | 244 | 73 | 985 | 4629 | 6201 |
| channelBookToServer | draftkings | pre | push | B | 244 | 76 | 987 | 4093 | 6060 |
| channelBookToServer | fanduel | live | push | A | 2555 | 976 | 1428 | 1962 | 2729 |
| channelBookToServer | fanduel | live | push | B | 2555 | 981 | 1421 | 1961 | 2703 |
| channelBookToServer | fanduel | pre | push | A | 123 | 1068 | 1441 | 1602 | 1602 |
| channelBookToServer | fanduel | pre | push | B | 123 | 1069 | 1443 | 1565 | 1565 |
| dkEngineToPublish | draftkings | live | push | A | 5000 | 555 | 1744 | 3671 | 7238 |
| dkEngineToPublish | draftkings | live | push | B | 5000 | 476 | 1734 | 3352 | 7238 |
| dkEngineToPublish | draftkings | pre | push | A | 244 | 20 | 930 | 4597 | 6155 |
| dkEngineToPublish | draftkings | pre | push | B | 244 | 20 | 930 | 4055 | 6025 |
| dkGatewayToServer | draftkings | live | push | A | 5000 | 20 | 33 | 152 | 1065 |
| dkGatewayToServer | draftkings | live | push | B | 5000 | 19 | 35 | 150 | 378 |
| dkGatewayToServer | draftkings | pre | push | A | 244 | 18 | 32 | 70 | 70 |
| dkGatewayToServer | draftkings | pre | push | B | 244 | 18 | 26 | 50 | 161 |
| linkLatency |  |  |  | B | 5000 | 0 | 1 | 1 | 57 |
| paint | draftkings | live | push | A | 50 | 4.5 | 7.4 | 8.5 | 8.5 |
| paint | draftkings | live | push | B | 190 | 5 | 7.8 | 10.3 | 10.8 |
| paint | draftkings | pre | push | A | 10 | 5.6 | 7.7 | 7.7 | 7.7 |
| paint | fanduel | live | poll | A | 56 | 4.9 | 9.2 | 9.2 | 9.2 |
| paint | fanduel | live | poll | B | 89 | 3.8 | 6.9 | 8.7 | 8.7 |
| paint | fanduel | live | push | A | 10 | 2.7 | 6.3 | 6.3 | 6.3 |
| paint | fanduel | live | push | B | 10 | 5.3 | 7.2 | 7.2 | 7.2 |
| paint | fanduel | pre | poll | A | 4 | 3.7 | 3.7 | 3.7 | 3.7 |
| paint | fanduel | pre | poll | B | 2 | 1.5 | 1.5 | 1.5 | 1.5 |
| rxToBrowser | draftkings | live | push | A | 50 | 18 | 27 | 28 | 28 |
| rxToBrowser | draftkings | live | push | B | 190 | 17 | 30 | 49 | 49 |
| rxToBrowser | draftkings | pre | push | A | 10 | 22 | 31 | 31 | 31 |
| rxToBrowser | fanduel | live | poll | A | 56 | 17 | 26 | 30 | 30 |
| rxToBrowser | fanduel | live | poll | B | 89 | 22 | 31 | 385 | 385 |
| rxToBrowser | fanduel | live | push | A | 10 | 16 | 21 | 21 | 21 |
| rxToBrowser | fanduel | live | push | B | 10 | 18 | 31 | 31 | 31 |
| rxToBrowser | fanduel | pre | poll | A | 4 | 19 | 19 | 19 | 19 |
| rxToBrowser | fanduel | pre | poll | B | 2 | -23 | -23 | -23 | -23 |
| secondCopyLag | draftkings |  |  |  | 5000 | 37 | 473 | 2329 | 3889 |
| secondCopyLag | fanduel |  |  |  | 5000 | 392 | 550 | 1147 | 2216 |
| serverProcessing | draftkings | live | push | A | 2675 | 0 | 1 | 1 | 2 |
| serverProcessing | draftkings | live | push | B | 2505 | 1 | 1 | 4 | 22 |
| serverProcessing | draftkings | pre | push | A | 111 | 0 | 1 | 1 | 1 |
| serverProcessing | draftkings | pre | push | B | 87 | 1 | 1 | 2 | 2 |
| serverProcessing | fanduel | live | poll | A | 1134 | 1 | 2 | 5 | 12 |
| serverProcessing | fanduel | live | poll | B | 1092 | 2 | 2 | 5 | 6 |
| serverProcessing | fanduel | live | push | A | 226 | 0 | 1 | 1 | 8 |
| serverProcessing | fanduel | live | push | B | 164 | 1 | 1 | 7 | 7 |
| serverProcessing | fanduel | pre | poll | A | 56 | 1 | 1 | 2 | 2 |
| serverProcessing | fanduel | pre | poll | B | 57 | 2 | 2 | 4 | 4 |
| serverProcessing | fanduel | pre | push | A | 4 | 0 | 0 | 0 | 0 |
| serverProcessing | fanduel | pre | push | B | 6 | 1 | 2 | 2 | 2 |
| serverToBrowser | draftkings | live | push | A | 50 | 18 | 26 | 28 | 28 |
| serverToBrowser | draftkings | live | push | B | 190 | 16 | 29 | 48 | 48 |
| serverToBrowser | draftkings | pre | push | A | 10 | 22 | 31 | 31 | 31 |
| serverToBrowser | fanduel | live | poll | A | 56 | 16 | 25 | 28 | 28 |
| serverToBrowser | fanduel | live | poll | B | 89 | 21 | 30 | 383 | 383 |
| serverToBrowser | fanduel | live | push | A | 10 | 16 | 20 | 20 | 20 |
| serverToBrowser | fanduel | live | push | B | 10 | 17 | 30 | 30 | 30 |
| serverToBrowser | fanduel | pre | poll | A | 4 | 18 | 18 | 18 | 18 |
| serverToBrowser | fanduel | pre | poll | B | 2 | -24 | -24 | -24 | -24 |

First copies by feed: {"fanduel|B":1319,"fanduel|A":1420,"draftkings|A":2787,"draftkings|B":2593}. Board counters: {"aggregatorErrors":0,"invalidQuotes":0,"olderRejected":177,"lateCopies":0,"heals":0,"failovers":21,"massRemovalsHeld":0,"watchdogFreezes":0,"watchdogRestarts":0,"rebinds":0}.
