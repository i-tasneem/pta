# Exit Levels (EMA + Bollinger Band confluence) — Progress

Durable DoD checklist for the EMA/BB confluence exit-placement work. One iteration
ticks the next unmet item; evidence (test names, decisions) recorded inline.

## Goal
Add EMA + Bollinger Band based exit (target & stop-loss) placement to the PTA V2
positioning engine, via CONFLUENCE with existing structural (OI-wall) levels.

## Locked decisions
- CONFLUENCE: SL/target = strongest level among {OI walls, EMAs, BB}, preferring
  clusters (2+ agree). Walls stay in the mix, never replaced.
- LEVELS: EMA(5,9,15,50,200) + BB(20,2) on 5m and 15m, PLUS daily 200-EMA. Daily
  200-EMA degrades gracefully if <200 daily candles (skip + log, don't block).
- EXITS ONLY: levels set target/SL placement; MUST NOT change signal generation,
  archetype detection, regime, or score.
- Levels on the UNDERLYING; chosen SL/target converted to the PINNED option's
  premium via existing delta/gamma path. Strike pinning preserved.

## Architecture
- `engine/src/levels/levels.ts` — pure TS: `ema`, `bollinger`, `computeLevels`
  (candles per tf + daily → flat `Level[]` on the underlying).
- `engine/src/levels/confluence.ts` — pure TS resolver: price + direction + walls
  + EMA/BB levels → `{ stop, target, stopSource, targetSource }`, cluster-preferring,
  documented tie-break + no-confluence fallback to the structural wall level.
- `signals/V2Adapter.js` — gathers candles from Redis ohlc streams + daily, calls
  the resolver, feeds resolved SL/target into `buildRiskPlan` (pinned strike).
- UI `components/SetupCard.jsx` — shows chosen levels + their source.
- `backtest/Backtester.js` — before/after exits comparison.

## DoD checklist
- [x] 1. EMA(5,9,15,50,200)+BB(20,2) on 5m & 15m + daily 200-EMA, seeded from
      history, refreshed live, persisted across restart. DONE — 5m/15m levels
      computed from existing live-refreshed Redis ohlc streams; daily 1d stream
      seeded at boot (`server.seedDailyHistory` → `provider.getDailyCandles`),
      persisted via Redis AOF, recomputed every poll. Degrades gracefully (skip
      + log) when daily history is unavailable.
- [x] 2. Pure TS confluence resolver (cluster-preferring, documented tie-break +
      no-confluence fallback). DONE — `engine/src/levels/confluence.ts`
      `resolveExits`. Tie-breaks: size → wall-containing → (stop: nearest wall /
      target: nearest price). Fallback = lone wall returns structural level.
- [x] 3. Integrated into V2Adapter plan: SL/target from resolver, converted to
      pinned strike premium (DONE). UI shows chosen levels + source (SetupCard).
- [x] 4. Signal generation / archetype / regime / score provably unchanged.
      DONE — `git diff 597847a..HEAD` over engine/src/{archetypes,scoring,regime,
      lifecycle,analytics,structure} is EMPTY; index.ts only adds exports;
      V2Adapter's onSnapshot/score/stage/transition path is unchanged (grep of
      the diff for those tokens is empty). 32 original module tests pass unchanged.
- [x] 5. Golden-fixture unit tests for level computation + resolver pass; full
      engine suite green. DONE — 17 new golden fixtures (9 levels + 8 confluence);
      full suite 49 pass / 0 fail.
- [x] 6. Backtester uses new exits; before/after comparison. DONE —
      `Backtester.simulateExits`/`compareExits` forward-simulate exits from the
      booked SL/target over the spot path; before = structural walls, after =
      EMA/BB confluence (levels from spot-derived candles). `runFromDb`/CLI emit
      both; `backtest_runs` stores engineTransitions + exitsBefore + exitsAfter.
      Golden fixture (140-snap warm-up+breakout) shows the confluence path
      engaging (EMA/BB cluster stops) and a measurable avgR difference
      (0.877 → 1.839). `runSnapshots` legacy harness untouched (no regression).
- [ ] 7. Builds, boots (mock), committed+pushed, SL/target + source levels render
      in the Setups/Signals UI.

## Baseline
- Engine suite green at start: 32 tests pass (`npm run test:engine`).
- Integration point confirmed: `V2Adapter.ensurePin()` feeds `h.structuralStop/
  Target` into `engine.buildRiskPlan`. Resolver slots in just before that call.
- Candle source: Redis streams `pta:ohlc:<tf>:<instrument>` (5m/15m have ≥200
  candles after bootstrap seeds last 500). Daily needs a new seed path.

## Iteration log

### Iteration 1 — level computation module (toward items 1, 5)
- Added `engine/src/levels/levels.ts`: pure `ema` (SMA-seeded, mirrors
  IndicatorEngine), `bollinger` (population std dev), `computeLevels` → flat
  `Level[]` with labels ("5m 50-EMA", "15m BB lower", "daily 200-EMA"). Missing/
  short histories degrade gracefully (level omitted, reason in `notes`). Daily
  200-EMA skipped with a logged note when <200 daily candles.
- Exported from `engine/src/index.ts`.
- Tests `engine/test/levels.test.js` (9): ema null/constant/known-case, bollinger
  null/constant/known-case, computeLevels label presence + EMA200 omission +
  daily skip note + empty-input degradation.
- Engine suite: 41 pass (was 32). No existing module touched → item 4 still holds.

### Iteration 2 — confluence resolver (item 2)
- Added `engine/src/levels/confluence.ts`: `resolveExits({direction, price,
  structuralStop, structuralTarget, levels})` → `{stop, target}` each with price,
  source label, members, agreement, hasWall, fallback. Walls are always a
  candidate (stay in the mix); strongest cluster wins; documented tie-breaks;
  no-confluence fallback returns the structural wall level unchanged.
- Exported from index. Tests `engine/test/confluence.test.js` (8): fallback,
  2-EMA cluster overriding lone wall, EMA-at-wall confluence (DoD "+ PE wall"
  shape), lone-EMA-doesn't-beat-wall, PE side resolution, target nearest-price
  tie-break, stop nearest-wall tie-break, degenerate price passthrough.
- Engine suite: 49 pass. Still no signal/score module touched → item 4 holds.

### Iteration 3 — V2Adapter integration (item 3 backend)
- `signals/V2Adapter.js`: `fetchCandles(tf)` (reads Redis ohlc streams),
  `refreshLevels(instrument)` (5m/15m/1d → `engine.computeLevels`, cached, daily
  skip logged once). `onChain` refreshes levels and threads them into `view`.
- `ensurePin` now runs `engine.resolveExits` (price=entryRef, wall-based
  structuralStop/Target + EMA/BB levels) and feeds the RESOLVED underlying
  stop/target into `buildRiskPlan`. Resolved levels + source labels + fallback
  flags are FROZEN on the pin (strike pinning preserved).
- `view` exposes `exitLevels{stop,target}` and `plan.stopSource/targetSource`;
  `persistTransition` persists the resolved underlying + source.
- Daily 1d stream not seeded yet → daily 200-EMA skipped gracefully (item 1
  remainder, next iteration).
- VERIFICATION: Redis/Postgres/Docker unavailable in this sandbox, so a literal
  `USE_MOCK=true node server.js` boot cannot connect. Substituted an in-process
  integration smoke (scratchpad `smoke_v2adapter.js`, stubbed event bus) that
  drives the real engine + adapter end-to-end: levels computed (16), confluence
  stop source "5m 50-EMA + 5m BB lower + ... + PE wall", target fell back to
  wall, plan produced, pin freeze holds. Engine suite 49 green.

### Iteration 4 — daily 200-EMA seeding (completes item 1)
- `DhanProvider.getDailyCandles` (POST /v2/charts/historical, EOD).
- `MockProvider.getDailyCandles` (~250 synthetic daily candles).
- `server.seedDailyHistory(inst)` seeds `pta:ohlc:1d:<symbol>` at boot (last 300
  daily candles, ~400 calendar-day window), paced vs rate limit; failures logged,
  never block. V2Adapter.fetchCandles('1d') already reads this stream.
- Verified: MockProvider daily (251 candles) → `computeLevels` yields
  `daily 200-EMA @ 22649`, no skip note. server.js parses + runs to the Redis
  connect (ECONNREFUSED expected — no Redis in sandbox). Engine suite green.

### Iteration 5 — UI display of chosen exit levels (item 3 UI / item 7 UI)
- `frontend/src/components/SetupCard.jsx`: new row under the premium plan showing
  `SL @ <underlying> · <source>` and `Tgt @ <underlying> · <source>` from
  `s.exitLevels`. `fmtSource` compacts long clusters ("5m 50-EMA +3 more") and
  shows "OI wall" on the no-confluence fallback.
- Frontend `vite build` clean (47 modules). Backend already emits `exitLevels` +
  `plan.stopSource/targetSource` (iteration 3).

### Iteration 6 — backtester before/after exits (item 6)
- `backtest/Backtester.js`: `SpotCandles` (spot-path → OHLC bars), `simulateExits`
  (book on TRIGGERED, forward-walk spot to target/stop, R per trade),
  `compareExits` (structural vs confluence). `runFromDb` returns + persists the
  comparison; `backtest.js` CLI prints BEFORE/AFTER lines.
- Tests `engine/test/backtest_exits.test.js` (3): metric-shape, books+resolves
  trades AND confluence engages (EMA/BB cluster stops) with measurable avgR delta
  (0.877→1.839), legacy `runSnapshots` intact.
- On real archived data the same comparison runs over dense 20s snapshots; the
  toy 1-min sparse stream would fall back, the warm-up+breakout stream diverges.
- Engine suite: 52 pass. Item 4 still holds (no signal-gen code touched).
