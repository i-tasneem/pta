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
- [ ] 1. EMA(5,9,15,50,200)+BB(20,2) on 5m & 15m + daily 200-EMA, seeded from
      history, refreshed live, persisted across restart.
- [ ] 2. Pure TS confluence resolver (cluster-preferring, documented tie-break +
      no-confluence fallback).
- [ ] 3. Integrated into V2Adapter plan: SL/target from resolver, converted to
      pinned strike premium; UI shows chosen levels.
- [ ] 4. Signal generation / archetype / regime / score provably unchanged (diff
      touches only exit/level code; existing module tests pass unchanged).
- [ ] 5. Golden-fixture unit tests for level computation + resolver pass; full
      engine suite green.
- [ ] 6. Backtester uses new exits; before/after comparison (win rate, avg R,
      expectancy) on archived data. Improvement aimed, not required.
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
