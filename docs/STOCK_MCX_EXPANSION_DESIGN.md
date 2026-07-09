# Stock Options (NSE) + MCX Energy Options — Expansion Design

Status: Phase 0 DEPLOYED to prod 2026-07-09 (commit ff43437); probe run
2026-07-09 — results in §0.6 and docs/probe-report-2026-07-09.json.
(Earlier "2026-07-08" stamps in this doc's history were the local box's
clock running a day slow; true dates are 2026-07-09.)
Scope: add NSE stock options and MCX CRUDEOIL + NATGASMINI options to the V2
positioning engine. Strategy design, capacity analysis, architecture changes,
phased build plan.

---

## 0. Verified facts that change the plan (checked 2026-07-08)

1. **Dhan's option-chain rate limit is per UNIQUE request, not global.**
   Docs (v2, option-chain): *"Rate limit for Option Chain API is set to one
   unique request every 3 seconds. This means you can fetch entire option
   chain for multiple different underlying instruments or multiple expiries of
   same instrument concurrently every 3 seconds."*
   The binding global cap is the **Data APIs bucket: 5 req/s**.
   Our `startChainPolling` (server.js) serializes ALL instruments through one
   3.5s slot — built on a misreading. Even the 6 indices are being polled ~7x
   slower than the API allows. The "180 stocks = 9 min stale = infeasible"
   conclusion in the V2 direction memory is wrong at its root.
2. **MCX is a first-class citizen of the same chain API.** Segment
   `MCX_COMM`, instrument `OPTFUT`; per-strike payload identical to indices
   (OI, IV, full greeks, volume, top bid/ask). No new data-shape work.
3. **Contracts confirmed live (Jul 2026):** NATGASMINI options (lot 250
   mmBtu, monthly, Jul series expires 24-Jul-2026), CRUDEOIL options (lot 100
   bbl, monthly, MCX's most liquid options). Both are options **on futures**
   → the chain's `UnderlyingScrip` is a futures securityId that **rolls
   monthly** (unlike NIFTY=13 forever).
4. **MCX session:** 09:00–23:30 IST (energy; 23:55 during US winter time).
   Engine `sessionPhase()` hardcodes NSE hours → everything after 15:30 is
   `POST` today. Needs per-exchange calendars.
5. **Trust but verify:** a day-0 probe must burst-test N distinct underlyings
   inside one 3s window and observe DH-904/429 behavior. The scheduler design
   below takes budget as a config number, so if reality is worse than docs,
   we degrade to a tiered plan without redesign.
6. **PROBE RESULTS (run on prod 2026-07-09 10:12 IST, live market):**
   - Per-(underlying,expiry) 3s floor: **CONFIRMED** — duplicate BANKEX
     request 429'd at +1s, succeeded at +4.2s.
   - Concurrent unique chains: **SUPPORTED** — 9 unique chains succeeded
     inside one 3.0s window (old assumption allowed exactly 1). The 3
     rejections were BANKNIFTY/BANKEX — instruments the live poller hit in
     the same window (prod's request wins the unique slot); prod logged
     zero 429s, consistent with collision, not a lower ceiling.
   - **Stock chains: NSE_EQ works as UnderlyingSeg** (NSE_FNO also worked);
     RELIANCE id 2885 → 101 strikes, 3 monthly expiries.
   - **MCX all confirmed** via MCX_COMM + front-month FUTCOM securityId:
     CRUDEOIL fut 520702 → 212 strikes; NATURALGAS fut 538685 → 88 strikes;
     NATGASMINI fut 538686 → 88 strikes. Mini mirrors the full-NG strike
     grid exactly — validating signal-from-full / execute-mini mapping.
   - **Production setting: `CHAIN_BUDGET_RPS=1.5`** (ships with Phase 1; no
     restart needed before then — current index demand is 0.286). That is
     5x the old serial rate, ~2x the full Phase 1+2 demand (0.8 req/s), and
     half the demonstrated throughput floor.

Sources: [Dhan option-chain docs](https://dhanhq.co/docs/v2/option-chain/),
[Dhan rate limits](https://dhan.co/support/platforms/dhanhq-api/what-are-the-api-rate-limits-for-dhan/),
[Dhan annexure (segments/instruments)](https://dhanhq.co/docs/v2/annexure/),
[MCX NATGASMINI](https://www.mcxindia.com/products/energy/natural-gas-mini).

---

## 1. Strategy — NSE stock options

### 1.1 The thesis transfers, the gates do the heavy lifting

"Trade the option writers" holds for liquid stock options, with three
amendments a trader must respect:

- **Writer dominance is weaker.** Index options are ~pure writer-vs-retail.
  Stock options add informed directional flow (pre-news accumulation),
  promoter/HNI hedging, and covered-call overwriting. ΔOI reads are still the
  edge, but a wall being *lifted through* by an informed buyer looks exactly
  like early capitulation — hence stricter persistence and volume confirmation.
- **Monthly-only expiry** (no stock weeklies). OI accumulates at round-number
  strikes for weeks → walls are *stickier and more meaningful* than index
  walls. But the gamma/theta clock is monthly: archetype fitness must know
  the expiry-cycle phase (early / mid / expiry-week), analogous to
  sessionPhase.
- **The underlying is a real stock** — real spot volume and bid/ask (indices
  needed the futures-proxy hack). Participation/ease-of-movement evidence
  gets *better* inputs than indices. Stock futures remain subscribed for
  basis + rollover pressure.

Design wins that pay off unchanged: everything-is-a-z-score (self-calibrates
per name — SBIN and RELIANCE need no per-stock thresholds), premium-ATR risk
units, per-instrument baselines, per-symbol SetupEngine instances.

### 1.2 Universe selection — liquidity IS the strategy

Outside the top ~20 F&O names, ATM spreads run 1–5% of premium; no R:R
gate survives that. The universe must be **data-driven and refreshed
nightly**, never hardcoded (the current dead `config.instruments.stocks`
list still contains HDFC, delisted 2023 — proof that hardcoded lists rot).

Nightly eligibility job (08:45 IST, from our own chain archive + NSE public
files):

| Criterion | Threshold (initial) |
|---|---|
| Options premium turnover (20d median) | top N of F&O list |
| ATM straddle spread | ≤ 1.5% of premium |
| Strikes with OI near ATM | ≥ 8 |
| MWPL ban list (NSE `fo_secban.csv`) | not in ban |
| Earnings window | not within T-2..T+1 |

Take top **10** to start (expected stable members: RELIANCE, HDFCBANK,
ICICIBANK, SBIN, AXISBANK, BAJFINANCE, TATAMOTORS, TATASTEEL, INFY,
ADANIENT), expandable to 20–25 with zero architecture change (see §3).
A name dropping out mid-day is NOT removed intraday (open setups finish);
it just doesn't re-enter tomorrow.

### 1.3 Archetype applicability (stocks)

| Archetype | Verdict | Stock-specific adjustment |
|---|---|---|
| Wall Capitulation Break | **Best fit** | Monthly walls at round strikes are heavily defended; require real spot-volume expansion + stock-futures OI confirm. Cleaner than indices (no basket mean-reversion drag). |
| Wall Absorption Fade | Keep (proven 79% shadow win on indices) | Stricter: persistence ≥3 snapshots, veto when basis z-score is extreme (informed flow can steamroll defense), earnings-proximity veto. |
| Writer Migration Continuation | Keep | Slower by nature on monthly strikes — wider windows; tolerant of 30s cadence. |
| Basis-Flow Divergence Reversal | Keep | Cash-futures basis is *genuinely informative* for stocks (arb + rollover pressure). Recalibrate full-strength scale from 20bps → 40–60bps (stock carry noise is wider). |
| Expiry Pin / Pin-Break | Expiry week only | Physical settlement makes last-2-day pin + ITM-writer-unwind dynamics strong. Gated to monthly expiry week. |

### 1.4 Stock-specific gates (new, all cheap, all veto-style)

1. **MWPL ban veto** — in-ban names produce mechanically distorted ΔOI (only
   unwinding is legal). No hypotheses form. (Near-ban ≥90% MWPL forced
   unwinding is itself a real flow signal — noted as a future archetype, not
   now.)
2. **Earnings blackout** — T-2..T+1 around earnings date: no new setups.
   IV-pumped baselines + binary event = the z-score machinery's blind spot.
   Feed: manual table first (10 names ≈ 40 events/yr), NSE corporate
   calendar fetch later.
3. **Expiry-week NWF damping** — writer OI unwinding in expiry week is
   mechanical (physical-settlement avoidance), not directional. Halve NWF
   evidence weight in the last 3 sessions.
4. **Sector concentration cap** — max 2 concurrent signals per sector
   (4 bank signals = 1 trade with 4x risk, not 4 trades). Presentation-layer
   gate.
5. **Liquidity gates per snapshot** — ATM spread ≤1.5%, pinned strike
   |delta| ≥ 0.35 (no illiquid far-OTM pins).
6. **R:R floor per class** — stocks trigger at **≥2.2** premium R:R (vs 1.8
   index) to pay for spread + gap risk.

---

## 2. Strategy — MCX energy options

### 2.1 Contracts and the signal-vs-execution split

| | CRUDEOIL options | NATGASMINI options |
|---|---|---|
| Underlying | CRUDEOIL futures (100 bbl) | NATGASMINI futures (250 mmBtu) |
| Expiry | Monthly, ~2 business days before futures expiry | Monthly (Jul-26 series: 24-Jul) |
| Settlement | Devolve into futures if ITM at expiry | Same |
| Liquidity | Deepest options on MCX | Newer/thinner than full NATURALGAS options |

**Open decision for user (§7):** full NATURALGAS options carry the dominant
writer positioning; NATGASMINI is the executable contract at 1/5 size. Both
strike on the same ₹/mmBtu scale, so signals derived from the *full* NG
chain map 1:1 to mini contracts. Recommendation: **signal from the liquid
chain (NATURALGAS), present NATGASMINI as the execution vehicle.** Crude has
no such split — CRUDEOIL options are the liquid chain, signal and execute.

### 2.2 The trader's honest read on MCX flow

Price discovery for both is **exogenous** — NYMEX WTI / Henry Hub × USDINR.
MCX option writers pin effectively during the quiet Indian day, then get
steamrolled by US catalysts in the evening. The positioning-flow thesis
still works (MCX is even more retail-writer-dominated than NSE), but only if
the engine respects the liquidity clock and the event calendar. These gates
are load-bearing, not decorative:

- **Session phases (MCX calendar):** OPEN 09:00–09:30 (NYMEX-gap digestion —
  stand-down, same as NSE opening noise), DAY 09:30–14:30 (thin, pin/fade
  territory), EU 14:30–18:00 (Brent/European flow arrives), US 18:00–21:00
  (**prime window** — NYMEX pit + data + deepest MCX volume), LATE 21:00–23:00,
  CLOSE 23:00–23:30 (squaring). Fitness: breaks want EU/US; fades want DAY;
  pins want expiry afternoon.
- **Event stand-downs (scheduled, hard veto on new triggers T-45m..T+15m):**
  EIA crude inventories Wed 20:00 IST (21:00 US winter), EIA nat-gas storage
  Thu 20:00 IST (NG's wildest hour of the week), OPEC+ meetings (manual
  entries). Open signals get an "event imminent" flag instead of a kill.
- **Archetypes:** Basis-Flow Divergence is **disabled** — the underlying IS
  the future, basis ≡ 0 by construction. Expiry Pin is *strong* on crude
  (documented max-pain gravity into devolvement). Break/Fade/Migration carry
  over with MCX session-fitness tables.
- **Expiry-day warning label:** ITM options devolve into futures positions —
  a screener signal held into expiry is a different instrument the next day.
  UI must say so.

### 2.3 Mechanical differences the architecture must absorb

1. **Rolling underlying:** chain calls need the *current front futures*
   securityId, re-resolved from the detailed scrip master; roll to next
   series at T-1 before option expiry. The WS tick subscription for the
   underlying rolls with it.
2. **Volume plumbing is simpler than indices:** the underlying future's own
   ticks give LTP + volume directly (no proxy pairing, no basis leg).
3. **Session length 14.5h:** rolling z-score baselines sized for a 6.25h NSE
   day must take window length from the instrument's calendar, and the
   same-time-of-day baseline keying already handles the rest.
4. **Ops window moves:** token refresh at ~07:11 IST already clears the full
   MCX day; restarts/maintenance must move to 00:00–08:30 IST; the process
   is hot 09:00–23:30.

---

## 3. Capacity — "how many stocks can we include?"

Budget model: chain fetches consume from Dhan's **Data-API bucket (5 req/s)**
with a **3s per-unique-underlying floor**. Reserve headroom for expiry-list
calls, intraday-candle seeds, and the existing candle/history traffic —
plan at **≤2 req/s sustained** (40% of bucket).

| Scenario | Indices | Stocks | MCX | Sustained req/s |
|---|---|---|---|---|
| Worst case — probe shows the limit is actually global 1/3.5s | 4 @ 28s | 8 @ 75s | 2 @ 75s | 0.29 |
| Docs-as-written ceiling | 6 @ 15s | 25 @ 20s | 2 @ 15s | ~1.8 |
| **Recommended start** | 6 @ 20s | **10 @ 30s** | 2 @ 20–30s (15s after NSE close) | ~0.8 |

Answers:
- **API supports 25+ stocks at 20s cadence** if the docs hold (probe
  confirms on day 0). The scheduler treats budget as config, so the worst
  case degrades to 8 stocks at slow cadence without redesign.
- **Recommendation: start with 10, by liquidity rank.** The real bottlenecks
  were never the API: (a) only ~15–25 names have screener-grade option
  liquidity, (b) every new name multiplies uncalibrated-threshold noise
  while V2 index validation is still open, (c) solo operator attention.
- **Side effect: indices improve.** Freeing the false global limit takes
  index cadence from 21s → ~15–20s, tightening every lifecycle timing the
  engine already runs.
- Non-binding by orders of magnitude: WS feed (5000 instruments/connection;
  we add ~25 spot+futures legs), OCI box (24GB vs a few MB of rolling
  windows), Postgres (~20k snapshots/day vs 6.4k today, and stock chains are
  5x narrower than index chains).

---

## 4. Architecture changes

**Engine core (L1–L5) is untouched** except parameter injection — the
z-score/archetype/scoring machinery is instrument-agnostic by design. The
work is in scheduling, calendars, gates, and plumbing.

| # | Component | Change |
|---|---|---|
| 1 | `config/pta.config.js` | Unified instrument spec: `{ symbol, class: INDEX\|STOCK\|MCX, segment, tier, calendar, cadenceMs, archetypeMask, execContract? }`. Per-class `v2` overrides (minTriggerRR, staleness, damping). Delete the dead `stocks` array. |
| 2 | `scanner/ChainScheduler.js` (new, replaces `startChainPolling`) | Token-bucket (configurable req/s) + 3s per-unique floor + priority queue by overdue-ratio + session-awareness (don't poll closed exchanges; MCX gets the whole budget after 15:30). Pure logic, golden tests. |
| 3 | `engine/src/structure/session.ts` | `sessionPhase(ts, calendar)` — NSE + MCX calendars mapping onto the same 7-phase enum so archetype fitness tables don't fork. `istDate` unchanged. |
| 4 | `engine/src/lifecycle/lifecycle.ts` | Cadence-relative defaults: `staleMs = max(90s, 4×cadenceMs)`, opts already injectable per engine — `V2Adapter.engineFor()` merges class overrides (one-line change point, verified). |
| 5 | `providers/DhanProvider.js` | Generalize `findIndexFutures` → `resolveUnderlying(class)`: OPTSTK/FUTSTK (stocks), OPTFUT/FUTCOM with monthly roll (MCX). Subscribe NSE_EQ spot ticks for stocks; MCX_COMM legs on the same WS (verify binary parse on MCX packets in probe). |
| 6 | `scripts/universe.js` (new) + nightly hook | Liquidity ranking from our own chain archive, ban-list fetch (public NSE csv), earnings table (PG, manual insert first). Writes active Tier-B list to Redis; server reads at boot + 08:50 refresh. |
| 7 | `signals/V2Adapter.js` | Class-aware gate hooks pre-`onChain`: ban / earnings / spread / delta floor / event stand-down (MCX) / expiry-week damping / sector cap at presentation. Per-class minTriggerRR. |
| 8 | `archive/ChainArchiver.js` | Add class/segment column; otherwise unchanged (keyed by symbol). **Archiving starts day 0 for all new instruments** — record-forward principle. |
| 9 | UI | Class-grouped tabs (Indices / Stocks / Commodities), lot-size + notional on cards, ban/earnings/event badges, expiry "devolves into futures" warning, evening-session liveness for MCX. |
| 10 | `backtest/Backtester.js` | Class filter; stock/MCX thresholds calibrated separately; exclude pre-fix futVolume-poisoned snapshots (already noted for indices). |

**Explicit non-goals now:** no order execution, no new archetypes (sector-
relative flow, MWPL forced-unwind, delivery-% confirmation are noted for
later), no WS-synthesized chains (that's Phase 3, only if scale demands).

---

## 5. Phased build plan

**Phase 0 — Foundation + probe (no behavior change for indices)**
- [x] Probe script BUILT (`scripts/probe-chain-limit.js`, 2026-07-08): burst
      of 12 unique (index, expiry) chains, duplicate-request floor test,
      stock underlying-segment test (NSE_EQ vs NSE_FNO via RELIANCE), MCX
      chain test (CRUDEOIL/NATURALGAS/NATGASMINI via front-month FUTCOM id).
      Fails closed without a live token — run on prod box or paste token.
      **RUN 2026-07-09 ✓** — verdict in §0.6; `CHAIN_BUDGET_RPS=1.5` goes
      live with the Phase 1 deploy.
- [x] ChainScheduler (`scanner/ChainScheduler.js` + `MarketCalendar.js`):
      token bucket + 3s per-unique floor + overdue-ratio priority + session
      gating (closed exchanges cost nothing; MCX inherits budget post-NSE).
      6 tests green (`npm run test:server`). Wired into server.js replacing
      the 3.5s round-robin; mock boot verified — all 6 indices polled at
      old cadence; `/api/health` now exposes per-chain `ageMs` vs cadence.
      Deliberate behavior change: no more off-hours/weekend polling (frozen
      chains were being archived 24/7).
- [x] Engine: `sessionPhase(ts, calendar)` with MCX calendar (new phases
      EU/US_PRIME/LATE + extended fitness tables), regime accepts
      `calendar` opt, EXPIRY_GRAVITY includes MCX evening phases;
      lifecycle `cadenceMs` opt → `staleMs = max(90s, 4×cadence)`.
      58 engine tests green (6 new).
- [ ] Regression gate: index chain ages in `/api/health` equal-or-better
      than today for 2 prod sessions after deploy.
- [ ] Start **archive-only** chain recording for the stock Tier-B list and
      both MCX chains (no engine attachment) — needs the probe's segment
      verdict + resolver (stock NSE_EQ ids, MCX front-month FUTCOM ids).

**Phase 1 — NSE stocks (shadow → live)**
- [x] BUILT 2026-07-09: resolver (`findStockInstruments` — NSE_EQ equity id
      for chain underlying + spot tick, nearest FUTSTK for basis; Redis-cached
      24h); stock spot volume (cumulative→delta in DhanProvider, preferred
      over futures volume for participation); per-class engine opts
      (cadence 30s, staleness 120s, calendar) via `V2Adapter.engineFor`;
      **shadow mode** (`signals.shadow` column — full lifecycle + outcomes,
      hidden from /api/v2/signals unless ?shadow=1); gates: MWPL ban veto +
      earnings blackout T-2..T+1 (`signals/StockGuards.js`, fail-closed per
      name, ban list stale-tolerant), pinned |delta|≥0.35 + ATM spread ≤1.5%
      + R:R≥2.2 at trigger; archive rows self-describing (inst_class).
      12-stock seed ENABLED shadow. `CHAIN_BUDGET_RPS` default now 1.5
      (probe-validated). Earnings feed manual: `scripts/add-earnings.js`.
      NOT built (deferred by design): nightly universe ranking job (seed is
      static until ranking data accrues), expiry-week NWF damping + sector
      cap (post-shadow calibration decisions), stock-discovery boot retry.
- [ ] Run **shadow-only** ≥ 2 weeks or until backtest on accrued archive
      sanity-checks thresholds per class. Shadow clock starts at first
      post-deploy session.
- [ ] Flip to live per-name (12 seed names), watch funnel telemetry by class.

**Phase 2 — MCX (shadow → live)**
- [ ] MCX calendar + event table + roll logic + basis-archetype mask +
      evening ops window.
- [ ] Shadow through ≥ 2 EIA Wednesdays/Thursdays before going live (the
      event gates are the thing being validated).

**Phase 3 — optional scale (only if stock edge proves out)**
- [ ] WS strike-window synthesis (ATM±5 × 2 legs in Full mode, local
      Black-76 IV/greeks) or Quote-API sweeps (1 req/s × 1000 instruments)
      → 30–50 names at 15s. Changes the bound from API to CPU. Not before.

**Sequencing rule (non-negotiable):** V2 produced its first live signals
ever on 2026-07-08; READY-score calibration from prod distributions is still
open. Index validation stays clean — Phase 0 must not alter index cadence
semantics (only improve staleness), and new classes stay shadow until index
calibration closes.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Docs wrong / hidden global chain limit | Day-0 probe; budget is config; worst-case column in §3 still ships 8 stocks. |
| Stock thresholds uncalibrated → noise flood | Shadow-first; per-class READY score env knobs; archive accrues before any signal shows. |
| MCX WS binary parse surprises (MCX_COMM packets) | Probe subscribes 2 MCX futures day 0 and diffs packet fields vs NSE. |
| Earnings/ban feeds go stale | Both are veto-gates that fail CLOSED for the affected name only (no setups formed ≠ crash). |
| Evening MCX session doubles process uptime exposure | Health monitor already runs; move restart window to 00:00–08:30; token refresh already pre-open. |
| Solo-operator attention split across 18 instruments | Sector cap, per-class signal caps, and the existing one-position-per-direction rule bound concurrent signals. |

## 7. Locked decisions (answered by user 2026-07-09)

1. **NG signal source: full NATURALGAS chain** drives signals; **NATGASMINI
   is the execution contract** presented on cards (same ₹/mmBtu strike
   scale, 1/5 lot). We poll NATURALGAS + CRUDEOIL chains; NATGASMINI chain
   is never polled.
2. **Stock count at go-live: 12** (nightly liquidity ranking keeps the best
   12 eligible names).
3. **Evening notifications: YES, different channel.** MCX signals fired
   18:00–23:30 IST route as away-from-desk notifications (push-style, not
   just dashboard broadcast) — implemented in Phase 2 alongside the MCX
   gates; channel choice (Telegram/ntfy/email) decided then.
4. **Probe: approved.** Runs any market morning, ~2 min of traffic. Needs a
   *valid* token at runtime — run on the prod box or paste the live token;
   the script must never generate a token itself (prod's TOTP cycle owns
   that; local .env token is stale).
