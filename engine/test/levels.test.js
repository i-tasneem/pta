const test = require('node:test');
const assert = require('node:assert');
const { ema, bollinger, computeLevels } = require('../dist/index.js');

const ramp = (n, start = 100, step = 1) =>
  Array.from({ length: n }, (_, i) => ({ close: start + i * step }));

test('ema: too few closes returns null', () => {
  assert.strictEqual(ema([1, 2], 3), null);
  assert.strictEqual(ema([], 5), null);
});

test('ema: constant series equals the constant', () => {
  assert.strictEqual(ema([42, 42, 42, 42, 42], 3), 42);
});

test('ema: known small case (SMA-seeded)', () => {
  // [1,2,3,4,5] period 3: seed=SMA(1,2,3)=2, k=0.5 -> 3 -> 4
  assert.strictEqual(ema([1, 2, 3, 4, 5], 3), 4);
});

test('bollinger: too few closes returns null', () => {
  assert.strictEqual(bollinger([1, 2], 3, 2), null);
});

test('bollinger: constant series collapses the bands', () => {
  const bb = bollinger([10, 10, 10, 10], 3, 2);
  assert.strictEqual(bb.middle, 10);
  assert.strictEqual(bb.upper, 10);
  assert.strictEqual(bb.lower, 10);
});

test('bollinger: known case uses population std dev', () => {
  // last 3 of [1..5] = [3,4,5], mean 4, var (1+0+1)/3=0.6667, std 0.8165
  const bb = bollinger([1, 2, 3, 4, 5], 3, 2);
  assert.strictEqual(bb.middle, 4);
  assert.ok(Math.abs(bb.upper - (4 + 2 * 0.81649658)) < 1e-6, 'upper ' + bb.upper);
  assert.ok(Math.abs(bb.lower - (4 - 2 * 0.81649658)) < 1e-6, 'lower ' + bb.lower);
});

test('computeLevels: 5m + 15m produce EMA + BB labels, short series omits EMA200', () => {
  const { levels, notes } = computeLevels({
    fiveMin: ramp(60, 100, 1),
    fifteenMin: ramp(60, 200, 1)
  });
  const labels = levels.map((l) => l.label);
  // present (enough for 5,9,15,50 and BB20)
  for (const p of [5, 9, 15, 50]) assert.ok(labels.includes(`5m ${p}-EMA`), `missing 5m ${p}-EMA`);
  assert.ok(labels.includes('5m BB upper') && labels.includes('5m BB lower') && labels.includes('5m BB mid'));
  assert.ok(labels.includes('15m 50-EMA'));
  // absent (need 200 closes)
  assert.ok(!labels.includes('5m 200-EMA'), '200-EMA should be omitted with 60 candles');
  // daily missing -> graceful note, no daily level
  assert.ok(!labels.includes('daily 200-EMA'));
  assert.ok(notes.some((n) => n.includes('daily 200-EMA skipped')), 'expected daily skip note');
});

test('computeLevels: 200 daily candles yield the daily 200-EMA major level', () => {
  const { levels, notes } = computeLevels({ daily: ramp(200, 1000, 2) });
  const daily = levels.find((l) => l.label === 'daily 200-EMA');
  assert.ok(daily, 'daily 200-EMA present');
  assert.strictEqual(daily.timeframe, 'daily');
  assert.strictEqual(daily.kind, 'EMA');
  assert.ok(!notes.some((n) => n.includes('daily 200-EMA skipped')));
});

test('computeLevels: empty input degrades to notes, no levels', () => {
  const { levels, notes } = computeLevels({});
  assert.strictEqual(levels.length, 0);
  assert.ok(notes.includes('no 5m candles'));
  assert.ok(notes.includes('no 15m candles'));
});
