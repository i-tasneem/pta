const test = require('node:test');
const assert = require('node:assert');
const EventNormalizer = require('../providers/EventNormalizer');

function harness(options) {
  const calls = [];
  const schema = { tick: (s) => `tick:${s}`, optionChain: (s) => `chain:${s}` };
  const bus = {
    hset: async (...args) => calls.push(['hset', ...args]),
    expire: async (...args) => calls.push(['expire', ...args]),
    publish: async (...args) => calls.push(['publish', ...args])
  };
  return { normalizer: new EventNormalizer(schema, bus, options), calls };
}

test('tick normalization preserves provider time and adds receive time', () => {
  const { normalizer } = harness();
  const tick = normalizer.normalizeTick({ tradingSymbol: 'EUR/USD', ltp: 1.08, timestamp: 1700000000 });
  assert.strictEqual(tick.timestamp, 1700000000000);
  assert.strictEqual(tick.exchangeTs, 1700000000000);
  assert.ok(tick.receivedTs >= tick.exchangeTs);
});

test('chain retention covers slow poll tiers and publishes freshness fields', async () => {
  const { normalizer, calls } = harness({ chainTtlSeconds: 420 });
  const chain = normalizer.normalizeOptionChain({
    timestamp: 1700000000000,
    underlyingPrice: 100,
    expiryDate: '2026-08-01',
    data: [{ strikePrice: 100, CE: { lastPrice: 5, bidPrice: 4.9, askPrice: 5.1 }, PE: {} }]
  }, 'TEST');
  await normalizer.writeOptionChain(chain);
  assert.ok(calls.some((c) => c[0] === 'expire' && c[1] === 'chain:TEST' && c[2] === 420));
  const write = calls.find((c) => c[0] === 'hset');
  assert.strictEqual(write[2].exchangeTs, 1700000000000);
  assert.ok(write[2].receivedTs > 0);
});
