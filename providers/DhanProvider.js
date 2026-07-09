// providers/DhanProvider.js
// Dhan API v2 integration: JSON subscription + little-endian binary feed,
// REST option chain (POST /v2/optionchain, rate-limited to 1 req / 3s).
const MarketDataProvider = require('./MarketDataProvider');
const axios = require('axios');
const WebSocket = require('ws');
const readline = require('readline');

// Feed response codes (Dhan v2 market feed)
const FEED = {
  TICKER: 2,
  QUOTE: 4,
  OI: 5,
  PREV_CLOSE: 6,
  FULL: 8,
  DISCONNECT: 50
};

class DhanProvider extends MarketDataProvider {
  constructor(config) {
    super(config);
    this.clientId = config.clientId;
    this.accessToken = config.accessToken;
    this.restUrl = config.restUrl || 'https://api.dhan.co';
    this.rateLimit = config.rateLimit || 25;
    this.ws = null;
    this.subscribedInstruments = new Set();
    this.securityMap = new Map();   // securityId -> { symbol, exchangeSegment, role }
    this.tickState = new Map();     // securityId -> accumulated tick fields
    this.futuresState = new Map();  // index symbol -> merged futures quote state
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.heartbeatInterval = null;
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000 / this.rateLimit;
    this.lastTickAt = 0;
  }

  async connect() {
    await this.validateToken();
    await this.connectWebSocket();
    this.connected = true;
    this.emit('connected');
  }

  async disconnect() {
    this.connected = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.emit('disconnected');
  }

  async validateToken() {
    try {
      const response = await this._request('GET', '/v2/fundlimit');
      return response.data;
    } catch (err) {
      const detail = err.response
        ? `${err.response.status} ${JSON.stringify(err.response.data)}`
        : err.message;
      throw new Error(`Token validation failed: ${detail}`);
    }
  }

  // Dhan throttles rapid reconnects and caps concurrent feed connections;
  // exactly one connect loop may run, backing off between attempts
  async connectWebSocket(maxAttempts = 5) {
    if (this._connecting) throw new Error('WS connect already in progress');
    this._connecting = true;

    try {
      let lastErr;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await this._connectWebSocketOnce();
        } catch (err) {
          lastErr = err;
          const delay = Math.min(5000 * attempt, 30000);
          console.warn(`WS connect attempt ${attempt}/${maxAttempts} failed (${err.message}), retrying in ${delay / 1000}s`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
      throw lastErr;
    } finally {
      this._connecting = false;
    }
  }

  _wsErrorDetail(err) {
    if (err.message) return err.message;
    if (err.errors?.length) return err.errors.map(e => e.message).join('; ');
    return `code=${err.code || 'unknown'}`;
  }

  async _connectWebSocketOnce() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `wss://api-feed.dhan.co?version=2&token=${this.accessToken}&clientId=${this.clientId}&authType=2`
      );
      this.ws = ws;
      let opened = false;

      ws.on('open', () => {
        opened = true;
        this.reconnectAttempts = 0;
        this.emit('ws:connected');
        this.startHeartbeat();

        // Steady-state handlers only exist after a successful open, so a
        // failed handshake never spawns reconnect loops
        ws.on('close', () => {
          this.emit('ws:disconnected');
          if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
          }
          if (this.connected) this.handleReconnect();
        });

        resolve();
      });

      ws.on('message', (data) => {
        this.handleWsMessage(data);
      });

      ws.on('error', (err) => {
        this.emit('ws:error', err);
        if (!opened) {
          reject(new Error(`WebSocket connect failed: ${this._wsErrorDetail(err)}`));
        }
      });
    });
  }

  handleWsMessage(data) {
    if (!Buffer.isBuffer(data)) return;

    // A frame may contain several packets back to back; the header's
    // message length (int16 LE at offset 1) is the total packet size.
    let offset = 0;
    while (offset + 8 <= data.length) {
      const code = data.readUInt8(offset);
      const msgLen = data.readUInt16LE(offset + 1);
      const packet = data.subarray(offset, msgLen >= 8 ? offset + msgLen : data.length);

      this.parsePacket(code, packet);

      if (msgLen >= 8 && offset + msgLen < data.length) {
        offset += msgLen;
      } else {
        break;
      }
    }
  }

  parsePacket(code, buf) {
    try {
      const securityId = buf.readUInt32LE(4).toString();

      switch (code) {
        case FEED.TICKER:
          this.updateTick(securityId, {
            lastPrice: buf.readFloatLE(8),
            timestamp: buf.readUInt32LE(12) * 1000
          });
          break;

        case FEED.QUOTE:
          this.updateTick(securityId, {
            lastPrice: buf.readFloatLE(8),
            timestamp: buf.readUInt32LE(14) * 1000,
            avgPrice: buf.readFloatLE(18),
            volume: buf.readUInt32LE(22),
            totalSellQty: buf.readUInt32LE(26),
            totalBuyQty: buf.readUInt32LE(30),
            dayOpen: buf.readFloatLE(34),
            dayClose: buf.readFloatLE(38),
            dayHigh: buf.readFloatLE(42),
            dayLow: buf.readFloatLE(46)
          });
          break;

        case FEED.FULL: {
          const fields = {
            lastPrice: buf.readFloatLE(8),
            timestamp: buf.readUInt32LE(14) * 1000,
            avgPrice: buf.readFloatLE(18),
            volume: buf.readUInt32LE(22),
            totalSellQty: buf.readUInt32LE(26),
            totalBuyQty: buf.readUInt32LE(30),
            openInterest: buf.readUInt32LE(34),
            dayOpen: buf.readFloatLE(46),
            dayClose: buf.readFloatLE(50),
            dayHigh: buf.readFloatLE(54),
            dayLow: buf.readFloatLE(58)
          };
          // Top of 5-level market depth (20 bytes per level from offset 62)
          if (buf.length >= 82) {
            fields.bidPrice = buf.readFloatLE(74);
            fields.askPrice = buf.readFloatLE(78);
          }
          this.updateTick(securityId, fields);
          break;
        }

        case FEED.PREV_CLOSE:
          this.updateTick(securityId, {
            previousClose: buf.readFloatLE(8),
            previousOI: buf.readUInt32LE(12)
          }, false);
          break;

        case FEED.OI:
          this.updateTick(securityId, {
            openInterest: buf.readUInt32LE(8)
          }, false);
          break;

        case FEED.DISCONNECT:
          this.emit('ws:serverDisconnect', {
            reason: buf.length >= 10 ? buf.readUInt16LE(8) : 0
          });
          break;

        default:
          this.emit('ws:unknown', { responseCode: code });
      }
    } catch (err) {
      this.emit('ws:parseError', { code, error: err.message });
    }
  }

  updateTick(securityId, fields, emitTick = true) {
    const mapping = this.securityMap.get(securityId);
    if (!mapping) return;

    const state = this.tickState.get(securityId) || {};
    // Spot legs with REAL volume (stocks; indices always report 0) convert
    // the cumulative day volume to deltas here, exactly like the FUT legs.
    const prevCumVol = state.volume || 0;
    Object.assign(state, fields);
    this.tickState.set(securityId, state);
    if (mapping.role !== 'FUT' && fields.volume !== undefined) {
      if (prevCumVol > 0 && fields.volume > prevCumVol) {
        state._pendingVol = (state._pendingVol || 0) + (fields.volume - prevCumVol);
      }
    }

    // Futures legs never emit; they feed volume/spread into the index tick.
    // Feed volume is cumulative for the day — convert to deltas here.
    if (mapping.role === 'FUT') {
      const fut = this.futuresState.get(mapping.symbol) || { lastCumVolume: 0, pendingVolume: 0 };
      if (fields.volume !== undefined) {
        if (fut.lastCumVolume > 0 && fields.volume > fut.lastCumVolume) {
          fut.pendingVolume += fields.volume - fut.lastCumVolume;
        }
        fut.lastCumVolume = fields.volume;
      }
      if (fields.bidPrice) fut.bid = fields.bidPrice;
      if (fields.askPrice) fut.ask = fields.askPrice;
      if (fields.avgPrice) fut.atp = fields.avgPrice;
      if (fields.lastPrice) fut.ltp = fields.lastPrice; // basis = fut.ltp - spot
      this.futuresState.set(mapping.symbol, fut);
      return;
    }

    if (!emitTick || !state.lastPrice) return;

    const prevClose = state.previousClose || 0;
    const change = prevClose ? state.lastPrice - prevClose : 0;

    // Indices trade no volume and quote no spread; both come from the
    // paired current-month future. Stocks have real spot volume — prefer it
    // (participation should measure the cash market, not the future).
    const fut = this.futuresState.get(mapping.symbol);
    const spotVolDelta = state._pendingVol || 0;
    state._pendingVol = 0;
    const futVolDelta = fut ? fut.pendingVolume : 0;
    if (fut) fut.pendingVolume = 0;
    const volumeDelta = spotVolDelta > 0 ? spotVolDelta : futVolDelta;

    this.lastTickAt = Date.now();
    this.emit('tick', {
      tradingSymbol: mapping.symbol,
      securityId,
      lastPrice: state.lastPrice,
      bidPrice: fut?.bid || state.bidPrice || 0,
      askPrice: fut?.ask || state.askPrice || 0,
      volume: volumeDelta,
      futLtp: fut?.ltp || 0,
      openInterest: state.openInterest || 0,
      change,
      changePercent: prevClose ? (change / prevClose) * 100 : 0,
      vwap: fut?.atp || state.avgPrice || 0,
      dayHigh: state.dayHigh || 0,
      dayLow: state.dayLow || 0,
      dayOpen: state.dayOpen || 0,
      previousClose: prevClose,
      timestamp: state.timestamp || Date.now()
    });
  }

  startHeartbeat() {
    // Dhan disconnects idle connections; RequestCode 50 from server signals it
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('ws:maxReconnectExceeded');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 60000);

    setTimeout(() => {
      this.emit('ws:reconnecting', { attempt: this.reconnectAttempts, delay });
      this.connectWebSocket()
        .then(() => this.resubscribe())
        .catch(() => {});
    }, delay);
  }

  async resubscribe() {
    const byRole = { INDEX: [], FUT: [] };
    for (const [securityId, m] of this.securityMap.entries()) {
      byRole[m.role === 'FUT' ? 'FUT' : 'INDEX'].push({
        symbol: m.symbol, securityId, exchangeSegment: m.exchangeSegment
      });
    }
    if (byRole.INDEX.length > 0) await this.subscribeTicks(byRole.INDEX);
    if (byRole.FUT.length > 0) await this.subscribeFutures(byRole.FUT);
  }

  _sendSubscription(list, requestCodes) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }
    if (list.length === 0) return;

    for (const requestCode of requestCodes) {
      this.ws.send(JSON.stringify({
        RequestCode: requestCode,
        InstrumentCount: list.length,
        InstrumentList: list
      }));
    }
  }

  async subscribeTicks(instruments) {
    const list = instruments
      .filter(i => i.securityId)
      .map(i => {
        this.securityMap.set(String(i.securityId), {
          symbol: i.symbol,
          exchangeSegment: i.exchangeSegment || 'IDX_I',
          role: 'INDEX'
        });
        this.subscribedInstruments.add(i.symbol);
        return {
          ExchangeSegment: i.exchangeSegment || 'IDX_I',
          SecurityId: String(i.securityId)
        };
      });

    // RequestCode 15 = ticker, 17 = quote; quote carries OHLC
    this._sendSubscription(list, [15, 17]);
  }

  // Paired index futures: subscribed in Full mode (21) for depth, providing
  // the volume/spread that cash indices don't have. symbol = the INDEX symbol.
  async subscribeFutures(pairs) {
    const list = pairs
      .filter(p => p.securityId)
      .map(p => {
        this.securityMap.set(String(p.securityId), {
          symbol: p.symbol,
          exchangeSegment: p.exchangeSegment || 'NSE_FNO',
          role: 'FUT'
        });
        return {
          ExchangeSegment: p.exchangeSegment || 'NSE_FNO',
          SecurityId: String(p.securityId)
        };
      });

    this._sendSubscription(list, [21]);
  }

  async unsubscribeTicks(instruments) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const list = instruments
      .filter(i => i.securityId)
      .map(i => {
        this.securityMap.delete(String(i.securityId));
        this.subscribedInstruments.delete(i.symbol);
        return {
          ExchangeSegment: i.exchangeSegment || 'IDX_I',
          SecurityId: String(i.securityId)
        };
      });

    if (list.length === 0) return;

    for (const requestCode of [16, 18]) {
      this.ws.send(JSON.stringify({
        RequestCode: requestCode,
        InstrumentCount: list.length,
        InstrumentList: list
      }));
    }
  }

  async getLTP(securityIds) {
    const ids = Array.isArray(securityIds) ? securityIds : [securityIds];
    const response = await this._request('POST', '/v2/marketfeed/ltp', {
      NSE_EQ: ids
    });
    return response.data;
  }

  // Returns the chain in the shape EventNormalizer.normalizeOptionChain expects
  async getOptionChain(underlyingScrip, underlyingSeg = 'IDX_I', expiry = null) {
    const body = {
      UnderlyingScrip: parseInt(underlyingScrip, 10),
      UnderlyingSeg: underlyingSeg
    };
    if (expiry) body.Expiry = expiry;

    const response = await this._request('POST', '/v2/optionchain', body);
    const payload = response.data?.data || {};
    const oc = payload.oc || {};

    const data = Object.entries(oc).map(([strike, row]) => ({
      strikePrice: parseFloat(strike),
      CE: this._mapLeg(row.ce),
      PE: this._mapLeg(row.pe)
    }));

    return {
      underlyingPrice: payload.last_price || 0,
      expiryDate: expiry || '',
      data
    };
  }

  _mapLeg(leg) {
    if (!leg) return {};
    return {
      lastPrice: leg.last_price || 0,
      bidPrice: leg.top_bid_price || 0,
      askPrice: leg.top_ask_price || 0,
      totalTradedVolume: leg.volume || 0,
      openInterest: leg.oi || 0,
      change: (leg.last_price || 0) - (leg.previous_close_price || 0),
      impliedVolatility: leg.implied_volatility || 0,
      delta: leg.greeks?.delta || 0
    };
  }

  async getExpiryList(underlyingScrip, underlyingSeg = 'IDX_I') {
    const response = await this._request('POST', '/v2/optionchain/expirylist', {
      UnderlyingScrip: parseInt(underlyingScrip, 10),
      UnderlyingSeg: underlyingSeg
    });
    return response.data?.data || [];
  }

  // Intraday history, normalized to [{ timestamp(ms), open, high, low, close, volume }]
  async getIntradayCandles(securityId, exchangeSegment, instrumentType, fromDate, toDate, interval = '1') {
    const response = await this._request('POST', '/v2/charts/intraday', {
      securityId: String(securityId),
      exchangeSegment,
      instrument: instrumentType,
      interval: String(interval),
      fromDate,
      toDate
    });

    const d = response.data || {};
    const candles = [];
    const n = (d.timestamp || []).length;
    for (let i = 0; i < n; i++) {
      candles.push({
        timestamp: d.timestamp[i] * 1000,
        open: d.open[i],
        high: d.high[i],
        low: d.low[i],
        close: d.close[i],
        volume: d.volume?.[i] || 0
      });
    }
    return candles;
  }

  // Daily (EOD) candles via /v2/charts/historical. Used to seed the daily
  // 200-EMA exit level (needs ~200 trading days). Same array response shape.
  async getDailyCandles(securityId, exchangeSegment, instrumentType, fromDate, toDate) {
    const response = await this._request('POST', '/v2/charts/historical', {
      securityId: String(securityId),
      exchangeSegment,
      instrument: instrumentType,
      expiryCode: 0,
      fromDate,
      toDate
    });

    const d = response.data || {};
    const candles = [];
    const n = (d.timestamp || []).length;
    for (let i = 0; i < n; i++) {
      candles.push({
        timestamp: d.timestamp[i] * 1000,
        open: d.open[i],
        high: d.high[i],
        low: d.low[i],
        close: d.close[i],
        volume: d.volume?.[i] || 0
      });
    }
    return candles;
  }

  // Streams the DETAILED scrip master and resolves the nearest-expiry index
  // future per underlying symbol. Columns (verified against the live CSV):
  // EXCH_ID, SECURITY_ID, INSTRUMENT(=FUTIDX), UNDERLYING_SYMBOL, SM_EXPIRY_DATE
  async findIndexFutures(symbols) {
    const url = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
    const response = await axios.get(url, { responseType: 'stream' });
    const rl = readline.createInterface({ input: response.data, crlfDelay: Infinity });

    // readline's async iterator SWALLOWS input-stream errors — a reset or
    // truncated download just ends the loop early with zero matches and no
    // exception. Capture stream errors explicitly and fail loudly, so the
    // caller can log and retry instead of silently running without futures.
    let streamError = null;
    response.data.on('error', (err) => { streamError = err; rl.close(); });

    const wanted = new Set(symbols);
    const today = new Date().toISOString().slice(0, 10);
    const best = new Map(); // symbol -> { securityId, exchangeSegment, expiry }
    let cols = null;
    let lineCount = 0;

    for await (const line of rl) {
      lineCount++;
      const values = line.split(',');

      if (!cols) {
        cols = {};
        values.forEach((h, i) => { cols[h.trim()] = i; });
        continue;
      }

      const get = (name) => {
        const i = cols[name];
        return i == null ? '' : (values[i] || '').trim();
      };

      if (get('INSTRUMENT') !== 'FUTIDX') continue;

      const underlying = get('UNDERLYING_SYMBOL');
      if (!wanted.has(underlying)) continue;

      const expiry = get('SM_EXPIRY_DATE').slice(0, 10);
      if (!expiry || expiry < today) continue;

      const exch = get('EXCH_ID');
      const current = best.get(underlying);
      if (!current || expiry < current.expiry) {
        best.set(underlying, {
          securityId: get('SECURITY_ID'),
          exchangeSegment: exch === 'BSE' ? 'BSE_FNO' : 'NSE_FNO',
          expiry
        });
      }
    }

    if (streamError) {
      throw new Error(`scrip master stream failed after ${lineCount} lines: ${streamError.message}`);
    }
    if (best.size === 0) {
      // The full file is ~200k lines with FUTIDX rows ~100k deep; zero matches
      // almost always means a truncated download, not a real absence.
      throw new Error(`scrip master parsed ${lineCount} lines but resolved 0 index futures (truncated download?)`);
    }
    return Object.fromEntries(best);
  }

  // Streams the DETAILED scrip master once and resolves, per stock symbol,
  // the NSE equity (option-chain underlying + spot tick; probe confirmed
  // NSE_EQ + equity id is the chain's underlying scheme) and the
  // nearest-expiry NSE stock future (basis leg). Same streaming hazards as
  // findIndexFutures: capture stream errors, fail loudly on zero matches.
  async findStockInstruments(symbols) {
    const url = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
    const response = await axios.get(url, { responseType: 'stream' });
    const rl = readline.createInterface({ input: response.data, crlfDelay: Infinity });

    let streamError = null;
    response.data.on('error', (err) => { streamError = err; rl.close(); });

    const wanted = new Set(symbols);
    const today = new Date().toISOString().slice(0, 10);
    const out = new Map(); // symbol -> { equity, future }
    let cols = null;
    let lineCount = 0;

    for await (const line of rl) {
      lineCount++;
      const values = line.split(',');

      if (!cols) {
        cols = {};
        values.forEach((h, i) => { cols[h.trim()] = i; });
        continue;
      }

      const get = (name) => {
        const i = cols[name];
        return i == null ? '' : (values[i] || '').trim();
      };

      const instr = get('INSTRUMENT');
      if (instr !== 'EQUITY' && instr !== 'FUTSTK') continue;
      if (get('EXCH_ID') !== 'NSE') continue;

      const underlying = get('UNDERLYING_SYMBOL');
      if (!wanted.has(underlying)) continue;

      const entry = out.get(underlying) || {};
      if (instr === 'EQUITY') {
        // Prefer the EQ series row (BSE uses A/B; NSE mainboard is EQ)
        const series = get('SERIES');
        if (!entry.equity || (series === 'EQ' && entry.equity.series !== 'EQ')) {
          entry.equity = { securityId: get('SECURITY_ID'), series };
        }
      } else {
        const expiry = get('SM_EXPIRY_DATE').slice(0, 10);
        if (expiry && expiry >= today && (!entry.future || expiry < entry.future.expiry)) {
          entry.future = {
            securityId: get('SECURITY_ID'),
            expiry,
            lotSize: parseFloat(get('LOT_SIZE')) || 0
          };
        }
      }
      out.set(underlying, entry);
    }

    if (streamError) {
      throw new Error(`scrip master stream failed after ${lineCount} lines: ${streamError.message}`);
    }
    if (out.size === 0) {
      throw new Error(`scrip master parsed ${lineCount} lines but resolved 0 stocks (truncated download?)`);
    }
    return Object.fromEntries(out);
  }

  // Streams the detailed scrip master and resolves the front TWO monthly
  // futures per commodity symbol (MCX FUTCOM). The chain API's underlying
  // for commodity options is the FUTURES securityId, which rolls monthly —
  // `next` lets the poller advance when the front option series expires.
  async findCommodityFutures(symbols) {
    const url = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
    const response = await axios.get(url, { responseType: 'stream' });
    const rl = readline.createInterface({ input: response.data, crlfDelay: Infinity });

    let streamError = null;
    response.data.on('error', (err) => { streamError = err; rl.close(); });

    const wanted = new Set(symbols);
    const today = new Date().toISOString().slice(0, 10);
    const bySymbol = new Map(); // symbol -> [{securityId, expiry, lotSize}] sorted
    let cols = null;
    let lineCount = 0;

    for await (const line of rl) {
      lineCount++;
      const values = line.split(',');

      if (!cols) {
        cols = {};
        values.forEach((h, i) => { cols[h.trim()] = i; });
        continue;
      }

      const get = (name) => {
        const i = cols[name];
        return i == null ? '' : (values[i] || '').trim();
      };

      if (get('INSTRUMENT') !== 'FUTCOM') continue;
      const underlying = get('UNDERLYING_SYMBOL');
      if (!wanted.has(underlying)) continue;

      const expiry = get('SM_EXPIRY_DATE').slice(0, 10);
      if (!expiry || expiry < today) continue;

      const list = bySymbol.get(underlying) || [];
      list.push({
        securityId: get('SECURITY_ID'),
        expiry,
        lotSize: parseFloat(get('LOT_SIZE')) || 0
      });
      bySymbol.set(underlying, list);
    }

    if (streamError) {
      throw new Error(`scrip master stream failed after ${lineCount} lines: ${streamError.message}`);
    }
    if (bySymbol.size === 0) {
      throw new Error(`scrip master parsed ${lineCount} lines but resolved 0 commodities (truncated download?)`);
    }

    const out = {};
    for (const [sym, list] of bySymbol) {
      list.sort((a, b) => a.expiry.localeCompare(b.expiry));
      out[sym] = { front: list[0], next: list[1] || null };
    }
    return out;
  }

  async getInstrumentMaster() {
    const url = 'https://images.dhan.co/api-data/api-scrip-master.csv';
    const response = await axios.get(url, { responseType: 'text' });
    return this.parseCSV(response.data);
  }

  parseCSV(csvText) {
    const lines = csvText.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim());
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',');
      const record = {};
      for (let j = 0; j < headers.length; j++) {
        record[headers[j]] = values[j]?.trim();
      }
      records.push(record);
    }
    return records;
  }

  async _request(method, endpoint, body = null, isRetry = false) {
    await this._rateLimit();

    const url = `${this.restUrl}${endpoint}`;
    const headers = {
      'access-token': this.accessToken,
      'client-id': this.clientId,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    const options = { method, url, headers };
    if (body) options.data = body;

    try {
      return await axios(options);
    } catch (err) {
      // Broker rejected the token — regenerate once (via server-supplied
      // handler) and retry, so an expired token self-heals instead of failing
      // every REST call until the next restart.
      const status = err.response && err.response.status;
      if (status === 401 && !isRetry && typeof this.onAuthError === 'function') {
        const fresh = await this.onAuthError();
        if (fresh) this.accessToken = fresh;
        return this._request(method, endpoint, body, true);
      }
      throw err;
    }
  }

  async _rateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minRequestInterval) {
      await new Promise(r => setTimeout(r, this.minRequestInterval - elapsed));
    }
    this.lastRequestTime = Date.now();
  }
}

module.exports = DhanProvider;
