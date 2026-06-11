# PTA - Personal Trading Assistant

Real-time, event-driven market intelligence engine for intraday options trading on Indian markets (NSE/BSE) via Dhan API.

## Architecture

- **Event-Driven**: No batch scanning. Every tick, candle close, OI change triggers immediate processing.
- **Redis-First**: All runtime data lives in Redis. SQLite is used only for archival.
- **6-Gate Signal Engine**: Decision-gate architecture separates opportunity quality from entry triggers.
- **Minimal UI**: User sees only actionable info (Entry, SL, Target, Confidence). Technical details are expandable.
- **No Trade Execution**: The PTA generates signals only. Users execute manually through their broker.

## Quick Start

### Prerequisites

- Node.js 18+
- Redis 7+
- Dhan broker account (for live data)

### Installation

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your Dhan credentials

# 3. Start Redis
redis-server

# 4. Start PTA
npm start
```

### Mock Mode (Testing without Dhan)

```bash
USE_MOCK=true npm start
```

## Project Structure

```
pta/
├── config/pta.config.js          # All configuration
├── providers/
│   ├── MarketDataProvider.js      # Abstract base class
│   ├── DhanProvider.js            # Dhan REST + WS implementation
│   ├── MockProvider.js            # Historical replay for testing
│   └── EventNormalizer.js         # Dhan → unified format
├── scanner/
│   ├── IndicatorEngine.js         # EMA, RSI, BB, ATR, VWAP
│   ├── TickScanner.js             # Real-time OHLC building
│   ├── CandleScanner.js           # Multi-timeframe candles
│   ├── TrendScanner.js            # EMA alignment, HTF bias
│   ├── MomentumScanner.js         # RSI slope, volume momentum
│   ├── OIScanner.js               # OI velocity, walls, patterns
│   └── ScannerOrchestrator.js     # Event consumer group mgmt
├── regime/
│   ├── RegimeEngine.js            # 8-state regime detection
│   └── MultiTimeframeEngine.js    # Cross-timeframe agreement
├── opportunity/
│   ├── OpportunityQualityEngine.js # Continuous scoring (0-100)
│   └── RankingEngine.js           # Redis Sorted Set leaderboard
├── signals/
│   ├── SignalTypes.js             # Enums and user-facing labels
│   ├── DecisionGate.js            # Base class for 6 gates
│   ├── Gate1-6.js                 # Individual gate implementations
│   ├── EntryTriggerEngine.js      # Gate orchestrator
│   ├── SignalLifecycleEngine.js   # State machine (10 states)
│   └── SignalPresentationService.js # Minimal vs detailed format
├── notification/
│   └── NotificationEngine.js      # Deduplication, throttling, dispatch
├── gateway/
│   ├── ExpressGateway.js          # REST API routes
│   ├── WebSocketGateway.js        # Real-time event broadcast
│   └── HealthMonitor.js           # System health checks
├── archive/
│   └── SignalArchiver.js          # SQLite archival pipeline
├── utils/
│   ├── RedisSchema.js             # Redis key definitions
│   ├── EventBus.js                # Redis Streams wrapper
│   └── PerformanceMonitor.js      # Latency tracking
├── server.js                      # Main entry point
└── package.json
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | System health check |
| `GET /api/opportunities?limit=10` | Top ranked opportunities |
| `GET /api/signals/active` | Currently active signals |
| `GET /api/signals/:id?details=true` | Signal by ID (with optional details) |
| `GET /api/signals/history` | Historical signals |
| `GET /api/market/:instrument` | Market state for instrument |
| `GET /api/notifications` | Recent notifications |

## WebSocket Events

Connect to `ws://localhost:3000` (via WebSocketGateway) to receive real-time events:

- `opportunity:score` - Opportunity score updated
- `opportunity:trigger` - New signal generated
- `signal:state` - Signal state changed
- `ranking:update` - Leaderboard changed
- `regime:change` - Market regime changed

## Signal Lifecycle

```
NEW → ACTIVE → WATCHING → TRIGGERED → ADD → EXIT → ARCHIVED
            ↓            ↓
         ABORTED       HOLD
```

## User-Facing Signal Format

```
SENSEX 81000 CE
BUY
Entry:     ₹ 245.50
SL:        ₹ 180.00
Target:    ₹ 380.00
Confidence: 92%
Status:    ACTIVE
Triggered: 09:34:22
Reason:    Strong Trend
[View Details ▼]
```

## Performance Targets

| Metric | Target |
|--------|--------|
| Tick Processing | < 50ms |
| Signal Evaluation | < 100ms |
| Ranking Update | < 10ms |
| Dashboard Refresh | < 250ms |

## License

Private - For personal use only.
