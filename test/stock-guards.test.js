const test = require('node:test');
const assert = require('node:assert');
const StockGuards = require('../signals/StockGuards');
const V2Adapter = require('../signals/V2Adapter');

test('ban CSV: NIL day parses to an empty set', () => {
  const set = StockGuards.parseBanCsv('Securities in Ban For Trade Date 09-JUL-2026: NIL\n');
  assert.strictEqual(set.size, 0);
});

test('ban CSV: plain and numbered symbol lines both parse', () => {
  const text = 'Securities in Ban For Trade Date 09-JUL-2026\nPNB\n2,GNFC\n 3 , M&M \n\n';
  const set = StockGuards.parseBanCsv(text);
  assert.deepStrictEqual([...set].sort(), ['GNFC', 'M&M', 'PNB']);
});

test('ban CSV: header symbols never leak into the set', () => {
  // The header is always skipped even when it contains no NIL marker
  const set = StockGuards.parseBanCsv('SYMBOL\nIDEA\n');
  assert.deepStrictEqual([...set], ['IDEA']);
});

test('ban CSV: empty/garbage input yields empty set', () => {
  assert.strictEqual(StockGuards.parseBanCsv('').size, 0);
  assert.strictEqual(StockGuards.parseBanCsv(null).size, 0);
});

test('stock trigger gate: far-OTM pin (low delta) is blocked', () => {
  const r = V2Adapter.stockTriggerViable({ delta: 0.2 }, { bid: 10, ask: 10.1 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /delta/);
});

test('stock trigger gate: wide spread is blocked, tight spread passes', () => {
  const pin = { delta: 0.5 };
  const wide = V2Adapter.stockTriggerViable(pin, { bid: 10, ask: 10.5 }); // ~4.9% of mid
  assert.strictEqual(wide.ok, false);
  assert.match(wide.reason, /spread/);

  const tight = V2Adapter.stockTriggerViable(pin, { bid: 10, ask: 10.1 }); // ~1% of mid
  assert.strictEqual(tight.ok, true);
});

test('stock trigger gate: missing quote data blocks entry', () => {
  assert.strictEqual(V2Adapter.stockTriggerViable({ delta: 0.5 }, null).ok, false);
  assert.strictEqual(V2Adapter.stockTriggerViable({ delta: 0.5 }, { bid: 0, ask: 0 }).ok, false);
});

test('PE pins pass the delta floor on absolute value', () => {
  assert.strictEqual(V2Adapter.stockTriggerViable({ delta: -0.45 }, { bid: 10, ask: 10.1 }).ok, true);
  assert.strictEqual(V2Adapter.stockTriggerViable({ delta: -0.2 }, { bid: 10, ask: 10.1 }).ok, false);
});
