// providers/DhanProvider.js
const MarketDataProvider = require('./MarketDataProvider');
const axios = require('axios');
const WebSocket = require('ws');

class DhanProvider extends MarketDataProvider {
  constructor(config) {
    super(config);
    this.clientId = config.clientId;
    this.accessToken = config.accessToken;
    this.restUrl = config.restUrl || 'https://api.dhan.co';
    this.wsUrl =`${config.wsUrl || 'wss://api-feed.dhan.co'}?version=2&token=${this.accessToken}&clientId=${this.clientId}&authType=2`;
    this.rateLimit = config.rateLimit || 25;
    this.ws = null;
    this.subscribedInstruments = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 1000;
    this.heartbeatInterval = null;
    this.requestQueue = [];
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000 / this.rateLimit;
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
      throw new Error(`Token validation failed: ${err.message}`);
    }
  }

  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(
  `wss://api-feed.dhan.co?version=2&token=${this.accessToken}&clientId=${this.clientId}&authType=2`
);

this.ws.on('open', () => {
  this.reconnectAttempts = 0;
  this.emit('ws:connected');
  this.startHeartbeat();
  resolve();
});

      this.ws.on('message', (data) => {
        this.handleWsMessage(data);
      });

      this.ws.on('error', (err) => {
        this.emit('ws:error', err);
        reject(err);
      });

      this.ws.on('close', () => {
        this.emit('ws:disconnected');
        this.handleReconnect();
      });
    });
  }

  handleWsMessage(data) {
    // Dhan binary protocol parsing
    if (Buffer.isBuffer(data)) {
      const responseCode = data.readUInt8(0);

      switch (responseCode) {
        case 15: // Tick data
          this.parseTickPacket(data);
          break;
        case 16: // Index data
          this.parseIndexPacket(data);
          break;
        case 17: // Full packet
          this.parseFullPacket(data);
          break;
        default:
          this.emit('ws:unknown', { responseCode, data });
      }
    }
  }

  parseTickPacket(buffer) {
    try {
      const instrumentToken = buffer.readUInt32BE(1);
      const ltp = buffer.readFloatBE(5);
      const bid = buffer.readFloatBE(9);
      const ask = buffer.readFloatBE(13);
      const volume = buffer.readUInt32BE(17);
      const timestamp = buffer.readUInt32BE(21) * 1000;

      const tick = {
        securityId: instrumentToken.toString(),
        lastPrice: ltp,
        bidPrice: bid,
        askPrice: ask,
        totalTradedQty: volume,
        timestamp
      };

      this.emit('tick', tick);
    } catch (err) {
      this.emit('ws:parseError', { type: 'tick', error: err.message });
    }
  }

  parseIndexPacket(buffer) {
    // Similar to tick but for index data
    try {
      const instrumentToken = buffer.readUInt32BE(1);
      const ltp = buffer.readFloatBE(5);
      const timestamp = buffer.readUInt32BE(21) * 1000;

      const tick = {
        securityId: instrumentToken.toString(),
        lastPrice: ltp,
        timestamp
      };

      this.emit('tick', tick);
    } catch (err) {
      this.emit('ws:parseError', { type: 'index', error: err.message });
    }
  }

  parseFullPacket(buffer) {
    // Extended packet with more fields
    this.parseTickPacket(buffer);
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const heartbeat = Buffer.alloc(2);
        heartbeat.writeUInt8(11, 0); // RequestCode 11
        heartbeat.writeUInt8(1, 1);
        this.ws.send(heartbeat);
      }
    }, 30000);
  }

  handleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emit('ws:maxReconnectExceeded');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(this.reconnectDelay * Math.pow(2, this.reconnectAttempts), 30000);

    setTimeout(() => {
      this.emit('ws:reconnecting', { attempt: this.reconnectAttempts, delay });
      this.connectWebSocket().catch(() => {});
    }, delay);
  }

  async subscribeTicks(instruments) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    const tokens = instruments.map(i => parseInt(i.securityId || i, 10)).filter(Boolean);
    if (tokens.length === 0) return;

    const packet = Buffer.alloc(3 + tokens.length * 4);
    packet.writeUInt8(15, 0); // RequestCode 15 (Subscribe)
    packet.writeUInt16BE(tokens.length, 1);

    for (let i = 0; i < tokens.length; i++) {
      packet.writeUInt32BE(tokens[i], 3 + i * 4);
    }

    this.ws.send(packet);

    for (const inst of instruments) {
      this.subscribedInstruments.add(inst.symbol || inst.securityId || inst);
    }
  }

  async unsubscribeTicks(instruments) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const tokens = instruments.map(i => parseInt(i.securityId || i, 10)).filter(Boolean);
    if (tokens.length === 0) return;

    const packet = Buffer.alloc(3 + tokens.length * 4);
    packet.writeUInt8(16, 0); // RequestCode 16 (Unsubscribe)
    packet.writeUInt16BE(tokens.length, 1);

    for (let i = 0; i < tokens.length; i++) {
      packet.writeUInt32BE(tokens[i], 3 + i * 4);
    }

    this.ws.send(packet);

    for (const inst of instruments) {
      this.subscribedInstruments.delete(inst.symbol || inst.securityId || inst);
    }
  }

  async getLTP(securityIds) {
    const ids = Array.isArray(securityIds) ? securityIds : [securityIds];
    const response = await this._request('POST', '/v2/quotes/ltp', {
      data: ids.map(id => ({ NSE: id, BSE: id }))
    });
    return response.data;
  }

  async getOptionChain(securityId) {
    const response = await this._request('GET', `/v2/option-chain/${securityId}`);
    return response.data;
  }

  async getHistoricalData(securityId, interval, from, to) {
    const response = await this._request(
      'GET',
      `/v2/charts/historical/${securityId}/${interval}/${from}/${to}`
    );
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