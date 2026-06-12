// providers/DhanProvider.js
// Dhan API v2 integration: JSON subscription + little-endian binary feed,
// REST option chain (POST /v2/optionchain, rate-limited to 1 req / 3s).
const MarketDataProvider = require('./MarketDataProvider');
const axios = require('axios');
const WebSocket = require('ws');

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
    this.securityMap = new Map();   // securityId -> { symbol, exchangeSegment }
    this.tickState = new Map();     // securityId -> accumulated tick fields
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

        case FEED.FULL:
          this.updateTick(securityId, {
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
          });
          break;

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
    Object.assign(state, fields);
    this.tickState.set(securityId, state);

    if (!emitTick || !state.lastPrice) return;

    const prevClose = state.previousClose || 0;
    const change = prevClose ? state.lastPrice - prevClose : 0;

    this.lastTickAt = Date.now();
    this.emit('tick', {
      tradingSymbol: mapping.symbol,
      securityId,
      lastPrice: state.lastPrice,
      bidPrice: state.bidPrice || 0,
      askPrice: state.askPrice || 0,
      totalTradedQty: state.volume || 0,
      openInterest: state.openInterest || 0,
      change,
      changePercent: prevClose ? (change / prevClose) * 100 : 0,
      vwap: state.avgPrice || 0,
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
    const instruments = Array.from(this.securityMap.entries()).map(
      ([securityId, m]) => ({ symbol: m.symbol, securityId, exchangeSegment: m.exchangeSegment })
    );
    if (instruments.length > 0) {
      await this.subscribeTicks(instruments);
    }
  }

  async subscribeTicks(instruments) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const list = instruments
      .filter(i => i.securityId)
      .map(i => {
        this.securityMap.set(String(i.securityId), {
          symbol: i.symbol,
          exchangeSegment: i.exchangeSegment || 'IDX_I'
        });
        this.subscribedInstruments.add(i.symbol);
        return {
          ExchangeSegment: i.exchangeSegment || 'IDX_I',
          SecurityId: String(i.securityId)
        };
      });

    if (list.length === 0) return;

    // RequestCode 15 = ticker, 17 = quote; subscribe to quote for OHLC + volume
    for (const requestCode of [15, 17]) {
      this.ws.send(JSON.stringify({
        RequestCode: requestCode,
        InstrumentCount: list.length,
        InstrumentList: list
      }));
    }
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

  async getHistoricalData(securityId, interval, from, to) {
    const response = await this._request('POST', '/v2/charts/intraday', {
      securityId: String(securityId),
      exchangeSegment: 'IDX_I',
      instrument: 'INDEX',
      interval: String(interval),
      fromDate: from,
      toDate: to
    });
    return response.data;
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

  async _request(method, endpoint, body = null) {
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

    return await axios(options);
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
