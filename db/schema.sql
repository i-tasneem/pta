-- PTA V2 Postgres schema. Idempotent: safe to run on every boot.
-- Redis stays ephemeral (live state, TTL'd); Postgres is the system of record.

-- ============================================================
-- MARKET DATA HISTORY  (the irreplaceable backtest asset)
-- Dhan does NOT serve historical option chains; every snapshot
-- we fail to record here is lost forever.
-- ============================================================

CREATE TABLE IF NOT EXISTS chain_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  symbol        TEXT        NOT NULL,
  ts            TIMESTAMPTZ NOT NULL,
  spot          DOUBLE PRECISION,
  fut           DOUBLE PRECISION,
  fut_vol       BIGINT,
  expiry        TEXT,
  atm_strike    DOUBLE PRECISION,
  pcr           DOUBLE PRECISION,
  max_pain      DOUBLE PRECISION,
  total_ce_oi   BIGINT,
  total_pe_oi   BIGINT
);

CREATE INDEX IF NOT EXISTS idx_chain_snap_symbol_ts
  ON chain_snapshots (symbol, ts DESC);

-- High-volume child table (~40 rows per snapshot). When this grows,
-- convert to monthly RANGE partitioning on a captured-at column.
CREATE TABLE IF NOT EXISTS chain_strikes (
  snapshot_id   BIGINT NOT NULL REFERENCES chain_snapshots(id) ON DELETE CASCADE,
  strike        DOUBLE PRECISION NOT NULL,
  ce_oi         BIGINT,
  pe_oi         BIGINT,
  ce_vol        BIGINT,
  pe_vol        BIGINT,
  ce_ltp        DOUBLE PRECISION,
  pe_ltp        DOUBLE PRECISION,
  ce_iv         DOUBLE PRECISION,
  pe_iv         DOUBLE PRECISION,
  ce_delta      DOUBLE PRECISION,
  pe_delta      DOUBLE PRECISION
);

CREATE INDEX IF NOT EXISTS idx_chain_strikes_snap
  ON chain_strikes (snapshot_id);

-- ============================================================
-- SIGNALS & OUTCOMES  (engine output + learning loop input)
-- ============================================================

CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,           -- app-generated, e.g. NIFTY_OI_WALL_BREAK_CE_<ts>
  symbol        TEXT NOT NULL,
  strategy      TEXT,
  regime        TEXT,
  direction     TEXT,                       -- CE | PE
  state         TEXT,                       -- FORMING|READY|TRIGGERED|ACTIVE|TARGET_HIT|STOPLOSS_HIT|INVALIDATED|EXPIRED
  score         DOUBLE PRECISION,
  confidence    DOUBLE PRECISION,
  entry_zone    JSONB,
  sl            JSONB,
  target        JSONB,
  reason        JSONB,                      -- human-readable WHY (array of strings)
  evidence      JSONB,                      -- full evidence vector for reproducibility
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  triggered_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol_created ON signals (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_strategy        ON signals (strategy);
CREATE INDEX IF NOT EXISTS idx_signals_state           ON signals (state);

CREATE TABLE IF NOT EXISTS signal_outcomes (
  signal_id     TEXT PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
  outcome       TEXT,                       -- TARGET_HIT | STOPLOSS_HIT | INVALIDATED | EXPIRED
  entry_px      DOUBLE PRECISION,
  exit_px       DOUBLE PRECISION,
  pnl           DOUBLE PRECISION,           -- underlying-space
  pnl_premium   DOUBLE PRECISION,           -- option-premium-space
  mae           DOUBLE PRECISION,           -- max adverse excursion
  mfe           DOUBLE PRECISION,           -- max favorable excursion
  duration_ms   BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rolled up nightly by the learning engine; drives data-driven confidence.
CREATE TABLE IF NOT EXISTS strategy_performance (
  strategy        TEXT NOT NULL,
  regime          TEXT NOT NULL,
  session_bucket  TEXT NOT NULL,            -- OPEN|MORNING|MIDDAY|AFTERNOON|CLOSE
  score_bucket    TEXT NOT NULL,            -- e.g. 50-60, 60-70, ...
  n               INTEGER NOT NULL DEFAULT 0,
  wins            INTEGER NOT NULL DEFAULT 0,
  win_rate        DOUBLE PRECISION,
  avg_r           DOUBLE PRECISION,
  profit_factor   DOUBLE PRECISION,
  expectancy      DOUBLE PRECISION,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (strategy, regime, session_bucket, score_bucket)
);

-- ============================================================
-- DIAGNOSTICS / OBSERVABILITY  (no effect on signal decisions)
-- One row per gate evaluation run; the funnel counters are a daily rollup.
-- ============================================================

CREATE TABLE IF NOT EXISTS gate_audit (
  id              BIGSERIAL PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  opportunity_id  TEXT,
  symbol          TEXT,
  direction       TEXT,
  reached_gate    INTEGER,     -- highest gate number evaluated
  failed_at_gate  INTEGER,     -- NULL if a signal was generated
  generated       BOOLEAN NOT NULL DEFAULT false,
  reason          TEXT,        -- failing gate's reason (carries the metric)
  regime          TEXT,
  score           DOUBLE PRECISION,
  gate_results    JSONB,       -- [{gate,pass,reason}] for gates evaluated
  metrics         JSONB        -- context snapshot at decision time
);
CREATE INDEX IF NOT EXISTS idx_gate_audit_ts        ON gate_audit (ts DESC);
CREATE INDEX IF NOT EXISTS idx_gate_audit_symbol    ON gate_audit (symbol);
CREATE INDEX IF NOT EXISTS idx_gate_audit_failed    ON gate_audit (failed_at_gate);

CREATE TABLE IF NOT EXISTS funnel_counters (
  day     DATE NOT NULL,
  metric  TEXT NOT NULL,
  count   BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id            BIGSERIAL PRIMARY KEY,
  strategy      TEXT,
  params        JSONB,
  period_start  TIMESTAMPTZ,
  period_end    TIMESTAMPTZ,
  metrics       JSONB,                      -- win_rate, sharpe, max_dd, profit_factor, expectancy
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- USERS & AUTH  (built in the auth phase; defined now so the
-- schema is complete and migrations don't churn later)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  pw_hash         TEXT NOT NULL,
  name            TEXT,
  role            TEXT NOT NULL DEFAULT 'FREE',   -- ADMIN|PREMIUM|FREE
  email_verified  BOOLEAN NOT NULL DEFAULT false,
  risk_profile    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Login fields (idempotent; the base CREATE above predates username auth)
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status   TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone    TEXT;
ALTER TABLE users ALTER COLUMN pw_hash DROP NOT NULL; -- PENDING users have no password yet

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  family_id   UUID NOT NULL,                -- rotation reuse-detection
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens (user_id);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id        UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  instruments    TEXT[],
  notif_channels JSONB,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlists (
  id       BIGSERIAL PRIMARY KEY,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist_items (
  watchlist_id BIGINT NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  PRIMARY KEY (watchlist_id, symbol)
);
