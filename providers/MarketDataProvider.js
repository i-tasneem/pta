// providers/MarketDataProvider.js
const EventEmitter = require('events');

class MarketDataProvider extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.connected = false;
  }

  async connect() {
    throw new Error('connect() must be implemented by subclass');
  }

  async disconnect() {
    throw new Error('disconnect() must be implemented by subclass');
  }

  async subscribeTicks(instruments) {
    throw new Error('subscribeTicks() must be implemented by subclass');
  }

  async unsubscribeTicks(instruments) {
    throw new Error('unsubscribeTicks() must be implemented by subclass');
  }

  async getLTP(securityIds) {
    throw new Error('getLTP() must be implemented by subclass');
  }

  async getOptionChain(securityId) {
    throw new Error('getOptionChain() must be implemented by subclass');
  }

  async getHistoricalData(securityId, interval, from, to) {
    throw new Error('getHistoricalData() must be implemented by subclass');
  }

  async getInstrumentMaster() {
    throw new Error('getInstrumentMaster() must be implemented by subclass');
  }

  async validateToken() {
    throw new Error('validateToken() must be implemented by subclass');
  }
}

module.exports = MarketDataProvider;
