const test = require('node:test');
const assert = require('node:assert');
const { resolveExits } = require('../dist/index.js');

const lvl = (price, label, kind = 'EMA', timeframe = '5m') => ({ price, label, kind, timeframe });
// tolerance at price 23000 with default 0.0012 pct = 27.6 underlying points.

test('CE no EMA/BB: stop & target fall back to the structural wall', () => {
  const r = resolveExits({
    direction: 'CE', price: 23000, structuralStop: 22900, structuralTarget: 23200, levels: []
  });
  assert.strictEqual(r.stop.price, 22900);
  assert.strictEqual(r.stop.fallback, true);
  assert.strictEqual(r.stop.source, 'wall (structural)');
  assert.strictEqual(r.target.price, 23200);
  assert.strictEqual(r.target.fallback, true);
});

test('CE: a 2-EMA cluster below price overrides a lone wall for the stop', () => {
  const r = resolveExits({
    direction: 'CE', price: 23000, structuralStop: 22900, structuralTarget: 23500,
    levels: [lvl(22950, '5m 50-EMA'), lvl(22955, '15m 50-EMA', 'EMA', '15m')]
  });
  assert.strictEqual(r.stop.price, 22950); // CE -> cluster minimum (most protective)
  assert.strictEqual(r.stop.agreement, 2);
  assert.strictEqual(r.stop.hasWall, false);
  assert.strictEqual(r.stop.fallback, false);
  assert.strictEqual(r.stop.source, '5m 50-EMA + 15m 50-EMA');
});

test('CE: EMA confluence AT the wall keeps the wall, source names both', () => {
  const r = resolveExits({
    direction: 'CE', price: 23000, structuralStop: 22900, structuralTarget: 23500,
    levels: [lvl(22910, '5m 50-EMA')]
  });
  assert.strictEqual(r.stop.price, 22900);  // min of {22900 wall, 22910 ema}
  assert.strictEqual(r.stop.agreement, 2);
  assert.strictEqual(r.stop.hasWall, true);
  assert.strictEqual(r.stop.fallback, false);
  assert.strictEqual(r.stop.source, '5m 50-EMA + PE wall'); // DoD example shape
});

test('CE: lone EMA does NOT beat a lone wall (tie -> wall, no confluence)', () => {
  const r = resolveExits({
    direction: 'CE', price: 23000, structuralStop: 22900, structuralTarget: 23500,
    levels: [lvl(22800, '5m 200-EMA')] // far from the wall -> separate cluster
  });
  assert.strictEqual(r.stop.price, 22900);
  assert.strictEqual(r.stop.fallback, true);
  assert.strictEqual(r.stop.hasWall, true);
});

test('PE: stop sits above price, target below; clusters resolve on the right side', () => {
  const r = resolveExits({
    direction: 'PE', price: 23000, structuralStop: 23200, structuralTarget: 22800,
    levels: [
      lvl(23080, '5m 50-EMA'), lvl(23085, '15m 50-EMA', 'EMA', '15m'), // above -> stop cluster (separate from wall@23200)
      lvl(22820, '5m BB lower', 'BB')                                  // below, near target wall
    ]
  });
  assert.strictEqual(r.stop.price, 23085);    // PE -> cluster maximum (most protective)
  assert.strictEqual(r.stop.agreement, 2);
  assert.strictEqual(r.stop.fallback, false);
  assert.strictEqual(r.target.price, 22820);  // PE target -> max of {22800 wall, 22820 bb}
  assert.strictEqual(r.target.hasWall, true);
  assert.strictEqual(r.target.agreement, 2);
});

test('CE target tie-break: equal clusters -> prefer the one NEAREST price', () => {
  const r = resolveExits({
    direction: 'CE', price: 23000, structuralStop: 22800, structuralTarget: 23300,
    levels: [
      lvl(23100, '5m 15-EMA'), lvl(23105, '15m 15-EMA', 'EMA', '15m'),  // near cluster
      lvl(23250, '5m 9-EMA'), lvl(23255, '15m 9-EMA', 'EMA', '15m')      // far cluster
    ]
  });
  assert.strictEqual(r.target.price, 23100);  // near cluster, min member
  assert.strictEqual(r.target.agreement, 2);
});

test('CE stop tie-break: equal clusters -> prefer the one NEAREST the wall', () => {
  const r = resolveExits({
    direction: 'CE', price: 23000, structuralStop: 22850, structuralTarget: 23500,
    levels: [
      lvl(22700, '5m 9-EMA'), lvl(22705, '15m 9-EMA', 'EMA', '15m'),    // far from wall
      lvl(22880, '5m 15-EMA'), lvl(22885, '15m 15-EMA', 'EMA', '15m')    // near wall (22850)
    ]
  });
  assert.strictEqual(r.stop.price, 22880);  // cluster nearest the wall, min member
  assert.strictEqual(r.stop.agreement, 2);
});

test('degenerate price passes the structural levels through as fallback', () => {
  const r = resolveExits({
    direction: 'CE', price: 0, structuralStop: 22900, structuralTarget: 23200,
    levels: [lvl(22950, '5m 50-EMA')]
  });
  assert.strictEqual(r.stop.price, 22900);
  assert.strictEqual(r.target.price, 23200);
  assert.strictEqual(r.stop.fallback, true);
});
