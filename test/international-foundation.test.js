const test = require('node:test');
const assert = require('node:assert');
const { InstrumentSpec } = require('../market/InstrumentSpec');
const { createMarketEvent } = require('../market/MarketEvent');
const { ProviderCapabilities } = require('../providers/ProviderCapabilities');

test('canonical IDs safely preserve international symbols containing slash', () => {
  const eurusd = new InstrumentSpec({
    assetClass: 'FOREX', venue: 'OANDA', symbol: 'EUR/USD',
    contractType: 'SPOT', baseCurrency: 'EUR', quoteCurrency: 'USD'
  });
  assert.strictEqual(eurusd.id, 'FOREX:OANDA:EUR%2FUSD:SPOT');
});

test('dated futures cannot be created without expiry', () => {
  assert.throws(() => new InstrumentSpec({
    assetClass: 'COMMODITY', venue: 'CME', symbol: 'CL',
    contractType: 'FUTURE', quoteCurrency: 'USD'
  }), /expiry/);
});

test('market events retain exchange and receive clocks', () => {
  const event = createMarketEvent({
    type: 'FUNDING', instrumentId: 'CRYPTO:DERIBIT:BTC-PERPETUAL:PERPETUAL',
    source: 'deribit', exchangeTs: 1700000000000, receivedTs: 1700000000025,
    payload: { rate: 0.0001 }
  });
  assert.strictEqual(event.receivedTs - event.exchangeTs, 25);
  assert.strictEqual(event.payload.rate, 0.0001);
});

test('delayed providers are rejected for entry even if they have candles', () => {
  const freeEod = new ProviderCapabilities({
    provider: 'free-eod', assetClasses: ['COMMODITY'],
    capabilities: ['CANDLES', 'HISTORICAL'], realtime: false, executionGrade: false,
    maxDelayMs: 86400000
  });
  assert.strictEqual(freeEod.supports('COMMODITY', 'CANDLES'), true);
  assert.throws(() => freeEod.assertUsableForEntry('COMMODITY', 'CANDLES'), /not approved/);
});
