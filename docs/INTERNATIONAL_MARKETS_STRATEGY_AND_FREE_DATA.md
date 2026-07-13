# International Markets: Strategy and Free-Data Research

Status: architecture/research baseline, 13 July 2026. This is a research and engineering specification, not a claim of tradable edge or financial advice.

## Decision summary

PTA should not copy its Indian option-OI logic unchanged into every international market. The common platform can be shared—normalization, clocks, lifecycle, risk, portfolio controls, replay and UI—but the information model differs:

- Forex is decentralized OTC. There is no authoritative global spot order book or global open interest. Use price, spread, session, rates/carry, macro events and (at slower horizons) CME FX positioning.
- Crypto is venue-fragmented but unusually transparent. Spot books, perpetual funding/basis, venue OI and Deribit option surfaces are usable, provided every feature is venue-labelled and sequence gaps are repaired.
- International commodities are centralized futures markets, but legitimate real-time exchange data is generally not free. Free official sources are strongest for end-of-day settlement/OI, weekly positioning and fundamentals—not intraday execution.

Recommended build order:

1. Forex MVP: OANDA practice feed, majors only, session-aware price strategies, shadow mode.
2. Crypto MVP: Coinbase/Binance spot plus Deribit perpetual/options, BTC and ETH only, shadow mode.
3. Commodity research MVP: CME end-of-day curve/VOI + CFTC + EIA/FRED; do not label it real-time until licensed CME/broker quotes are connected.

## Free-data map

| Source | Markets and useful fields | Cost/access | Suitable use | Critical limitation |
|---|---|---|---|---|
| [OANDA v20](https://developer.oanda.com/rest-live-v20/introduction/) | FX/metal/CFD tradeable bid-ask, candles, account-specific liquidity | Free demo account and token; practice REST/stream endpoints | Forex shadow/live screener aligned to an OANDA execution account | Broker/CFD price, not a consolidated global FX tape; availability depends on jurisdiction |
| [Coinbase Advanced WebSocket](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/websocket/websocket-overview) | Crypto trades, ticker, candles and level-2 book | Public; most market channels need no authentication | Execution-grade spot discovery on listed products | Venue-specific; consumer must detect sequence gaps and keep a level-2 book synchronized |
| [Binance public market-data API](https://developers.binance.com/en/docs/products/spot/rest-api) and [bulk archive](https://data.binance.vision/) | Spot/futures trades, books, candles and derivatives fields; bulk history | Public market endpoints | Crypto cross-venue research and historical bootstrap | Jurisdiction/availability risk; venue-specific OI/funding cannot be treated as global |
| [Deribit public API](https://docs.deribit.com/) | BTC/ETH options and futures: bid/ask, mark IV, OI, funding, expiries, trades | Public methods and WebSocket | Crypto option surface, skew, term structure, basis/funding | Historical full-chain/order-book snapshots are not a substitute for archiving the live surface ourselves |
| [CFTC COT API/reports](https://www.cftc.gov/MarketReports/CommitmentsofTraders/AbouttheCOTReports/index.htm) | Weekly futures and futures+options positioning for FX and commodities | Free downloads/API | Slow positioning/crowding regime feature | Tuesday positions released Friday; never an intraday trigger |
| [CME Volume & OI](https://www.cmegroup.com/market-data/volume-open-interest.html) and [Daily Bulletin](https://www.cmegroup.com/market-data/daily-bulletin.html) | Futures/options settlements, volume and OI | Free reference reports | EOD curves, roll research, options/OI research | CME explicitly describes website data as reference data, not a replacement for its real-time feed |
| [EIA Open Data](https://www.eia.gov/opendata/documentation.php) | Petroleum, natural gas, storage, production and inventories | Free API key | Energy fundamental/event features | Publication cadence and revisions; not price data |
| [FRED API](https://fred.stlouisfed.org/docs/api/fred/overview.html) | Rates, macro, inventories and many commodity/FX reference series | Free API key | Macro and slow-regime features | Mixed source/release timing; point-in-time vintages matter |
| [ECB Data API](https://data.ecb.europa.eu/help/api/data) | Daily EUR reference rates and macro statistics | Public SDMX API | Daily FX validation/value features | Reference averages for information, not executable quotes |
| [BIS Data Portal](https://data.bis.org/help/export) | Bilateral/effective exchange rates and international financial statistics | Free export/SDMX subject to terms | Long-horizon FX value and research | Low frequency; not a trading feed |
| [Alpha Vantage](https://www.alphavantage.co/documentation/) | FX/crypto/commodity time series | Free key for selected endpoints | Convenience/prototyping only | Current documentation marks FX intraday as premium; limits and semantics make it unsuitable as PTA's primary live feed |

Bottom line: crypto has genuinely useful free real-time public data. Forex has useful free broker data after opening a demo account. For CME/ICE commodity execution, there is no free source I would certify as exchange-grade real-time data; use official free EOD/fundamental data for research and budget for broker/exchange entitlements before live deployment.

## Strategy research program

### Forex

Start with liquid majors: EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, USD/CHF and NZD/USD. Add EUR/JPY and GBP/JPY only after the base pipeline is stable.

1. Session trend/breakout
   - Features: Asian range, London open displacement, New York overlap, multi-horizon realized volatility, OANDA bid-ask and spread percentile.
   - Entry: close outside a volatility-scaled session range with trend and spread confirmation; never use a one-tick breach.
   - Exit: ATR/structure stop, time stop before liquidity deteriorates, and event stand-down.
   - Validation: separate London, overlap and post-New-York samples; include spread widening around rollover.

2. Medium-horizon momentum plus carry
   - Rank currencies by 1–12 month trend and interest-rate differential; volatility scale the portfolio and diversify rather than making a single-pair carry bet.
   - Carry and momentum are established research baselines, but carry contains crash/peso risk; see [NBER: Carry Trade and Momentum in Currency Markets](https://www.nber.org/papers/w16942).
   - Use central-bank/FRED rates point-in-time, not today's revised series applied to history.

3. Intraday overreaction/mean reversion
   - Only test after abnormal standardized return plus liquidity recovery (spread normalizes and price re-enters the pre-shock range).
   - Exclude scheduled high-impact releases and central-bank windows. This is a liquidity strategy, not generic RSI mean reversion.

What not to port: option-writer walls, global PCR or spot OI. CME FX futures COT/OI is useful context, but it is a related centralized market—not the whole OTC FX market. BIS's 2025 survey is the right structural reference for the size and decentralization of FX: [BIS Triennial Survey](https://www.bis.org/statistics/rpfx25_fx.pdf).

### Crypto

Start with BTC and ETH. Treat each venue and contract as a separate instrument, then build aggregate features with explicit weights.

1. Trend/momentum with 24/7 regime controls
   - Features: multi-horizon return, realized volatility, spot volume, book imbalance, weekend flag and cross-venue confirmation.
   - Use volatility targeting and a circuit breaker for exchange/data dislocations. Research finds strong crypto-specific time-series momentum, but the original sample and market structure must be revalidated: [NBER: Risks and Returns of Cryptocurrency](https://www.nber.org/papers/w24877).

2. Perpetual funding and futures-basis carry
   - Measure annualized basis net of trading fees, funding, borrow, slippage and transfer/custody constraints.
   - A conservative signal is relative-value/cash-and-carry, not an unhedged bet that high funding must immediately reverse.
   - BIS documents that crypto carry is large, time-varying and connected to boom/bust dynamics: [BIS Working Paper 1087](https://www.bis.org/publ/work1087.htm).

3. OI-price-funding regime
   - Price up + OI up + positive funding is leveraged trend/crowding; price down + OI down is deleveraging. These are regime labels, not entries by themselves.
   - Require spot confirmation across independent venues. An exchange outage or stablecoin dislocation invalidates aggregation.

4. BTC/ETH option surface
   - Features: constant-maturity ATM IV, realized-minus-implied spread, 25-delta risk reversal, butterfly, term-structure slope, option volume/OI and futures basis.
   - Begin with forecasting/alerts, not naked short-vol execution. Surface construction requires forward price, time-to-expiry, quote-quality filtering and delta interpolation.
   - Deribit exposes bid/ask, OI, funding and mark IV in its [book summary](https://docs.deribit.com/api-reference/market-data/public-get_book_summary_by_instrument) and historical volatility through a [public endpoint](https://docs.deribit.com/api-reference/market-data/public-get_historical_volatility).

What not to assume: OI is not automatically “writers,” high funding is not a precise reversal clock, and the same symbol across venues is not fungible after fees, collateral and counterparty risk.

### International commodities

Research universe: WTI crude (CL), Henry Hub gas (NG), gold (GC), silver (SI), copper (HG), corn (ZC), wheat (ZW) and soybeans (ZS). Brent/ICE should wait for a licensed source.

1. Curve carry plus trend
   - Build a constant-maturity futures curve, not a stitched front-contract price. Features: front/next annualized slope, wider curve PCA factors, 3/6/12-month momentum and realized volatility.
   - Backwardation/contango reflects inventory/convenience yield and roll economics; [CME's explanation](https://www.cmegroup.com/education/courses/introduction-to-ferrous-metals/what-is-contango-and-backwardation) is a useful market-structure baseline.
   - Momentum and term-structure overlays have academic support, but must be retested net of contemporary rolls and fees: [NBER: Tactical and Strategic Value of Commodity Futures](https://www.nber.org/papers/w11222).

2. Fundamental surprise
   - Energy: EIA crude/product inventory and natural-gas storage surprise relative to a frozen pre-release consensus; trade only after the release and spread normalization.
   - Agriculture: later add USDA release data and crop calendars. Never mix revised final values into a historical first-release backtest.

3. COT crowding/regime
   - Normalize managed-money and producer positions by total OI and their own rolling history. Use weekly crowding as a trend-risk modifier, not a Friday intraday entry.

4. Options/OI surface, EOD first
   - Use settlement IV/skew and strike OI as slow support/resistance/context. Do not infer that an OI concentration is naked dealer exposure; positions may be spreads or hedged.

5. Seasonality
   - Estimate by contract month and delivery economics, then demand stability across subperiods. Calendar effects are hypotheses, not hard-coded truths.

## Validation standard before any strategy becomes live

- Point-in-time instrument master, expiry and roll rules; no survivorship or front-contract stitching leakage.
- Exchange timestamp and receive timestamp stored separately; sequence-gap and stale-data flags included in the replay.
- Walk-forward testing with untouched final holdout. Parameter search is nested inside training windows.
- Purge/embargo overlapping labels. Report results by year, volatility regime, session, venue and instrument—not only aggregate Sharpe.
- Execution at bid/ask with commissions, funding, borrow, roll, market impact and rejected/partial fills. For options, archive full executable quotes.
- Portfolio layer: volatility budget, correlated-cluster caps, currency and USD exposure, per-venue/counterparty caps, daily loss and stale-feed kill switches.
- Shadow/live promotion requires enough independent trades, stable calibration, positive net expectancy, bounded drawdown and no single regime/instrument dominating P&L.

## Data engineering implications for PTA

The Phase 2 foundation now uses canonical IDs such as `FOREX:OANDA:EUR%2FUSD:SPOT`, explicit contract types, venue aliases and provider capabilities. The next adapters should all emit the same versioned event envelope with exchange/receive clocks and data-quality flags.

Do not create one universal “international score.” Create strategy-specific calibrated probabilities, then a portfolio allocator that compares expected return after cost per unit of risk. A forex breakout, BTC funding trade and crude curve trade have different clocks, holding periods and failure modes; forcing them through the same OI score would hide rather than reduce risk.

## Library modernization decision

Registry verification on 13 July 2026 found the following major-version gaps: Express 4→5, Redis 4→6, better-sqlite3 11→12, dotenv 16→17, TOTP generator 1→2, TypeScript 5→7, React 18→19, Vite 5→8 and Tailwind 3→4. These are not safe “version-number-only” edits.

This tranche moves the runtime/build baseline to Node 24 LTS, makes builds use lockfiles (`npm ci`), removes install side effects from `npm run build`, and makes the default test command run the actual Node test suites. Current compatible majors should remain until individual migration branches add contract tests:

1. Applied now: Axios 1.18.1, pg 8.22, ws 8.21, Autoprefixer 10.5.2, PostCSS 8.5.18, Tailwind 3.4.19, Vite 8.1.4 and React plugin 6.0.3. A `form-data` 4.0.6 override removes the transitive CRLF-injection advisory.
2. Runtime migration: better-sqlite3 12 and dotenv 17, including native-image verification.
3. Server migration: Express 5 and Redis 6, with routing, middleware, pub/sub and shutdown tests.
4. Frontend migration: React 19 and Tailwind 4 with visual regression checks; Vite 8 is already applied because the previous line had unresolved development-server advisories.
5. TypeScript 7 and TOTP 2 last; both need explicit API/compiler migration. Jest can be removed because PTA now uses Node's built-in test runner.

The principle is simple: newest supported versions, not an untested simultaneous major upgrade in a trading system.
