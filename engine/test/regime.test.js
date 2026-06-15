const test = require('node:test');
const assert = require('node:assert');
const { sessionPhase, corridor, RegimeClassifier } = require('../dist/index.js');

// 2026-06-16 is a Tuesday (a NIFTY weekly expiry-style date used in fixtures)
function tsAtIST(dateStr, h, m) {
  // build a UTC ms for the given IST wall-clock time
  const [Y, Mo, D] = dateStr.split('-').map(Number);
  const utcMs = Date.UTC(Y, Mo - 1, D, h, m) - 330 * 60000;
  return utcMs;
}
function leg(oi, iv = 12) { return { ltp: 100, oi, volume: 0, iv, delta: 0.5 }; }
function ladder(spec, ivByStrike = {}) {
  return Object.entries(spec).map(([strike, [ce, pe]]) => ({
    strike: Number(strike),
    ce: leg(ce, ivByStrike[strike]),
    pe: leg(pe, ivByStrike[strike])
  }));
}

test('sessionPhase maps IST wall-clock correctly', () => {
  assert.strictEqual(sessionPhase(tsAtIST('2026-06-16', 9, 20)), 'OPEN');
  assert.strictEqual(sessionPhase(tsAtIST('2026-06-16', 10, 0)), 'MORNING');
  assert.strictEqual(sessionPhase(tsAtIST('2026-06-16', 12, 0)), 'MIDDAY');
  assert.strictEqual(sessionPhase(tsAtIST('2026-06-16', 14, 0)), 'AFTERNOON');
  assert.strictEqual(sessionPhase(tsAtIST('2026-06-16', 15, 20)), 'CLOSE');
  assert.strictEqual(sessionPhase(tsAtIST('2026-06-16', 8, 0)), 'PRE');
});

test('corridor finds nearest walls around spot', () => {
  const a = {
    ceWalls: [{ strike: 23200, oi: 9, z: 3, side: 'CE' }, { strike: 23400, oi: 8, z: 2.5, side: 'CE' }],
    peWalls: [{ strike: 22800, oi: 9, z: 3, side: 'PE' }]
  };
  const c = corridor(a, 23000);
  assert.strictEqual(c.resistance, 23200);
  assert.strictEqual(c.support, 22800);
  assert.strictEqual(c.width, 400);
});

function snap(over) {
  return {
    instrument: 'NIFTY', ts: tsAtIST('2026-06-15', 10, 0), spot: 23000, atmStrike: 23000,
    pcr: 1, totalCeOi: 0, totalPeOi: 0, expiry: '2026-06-16', strikes: [], ...over
  };
}

test('expiry afternoon => EXPIRY_GRAVITY allowing only the pin', () => {
  const rc = new RegimeClassifier();
  const a = { ready: true, flowState: 'NEUTRAL', netWriterFlow: 0, priceDelta: 0,
    peCentroid: 22900, ceCentroid: 23100, ceWalls: [], peWalls: [] };
  const r = rc.classify(a, snap({ ts: tsAtIST('2026-06-16', 14, 0), expiry: '2026-06-16',
    strikes: ladder({ 23000: [100, 100] }) }));
  assert.strictEqual(r.regime, 'EXPIRY_GRAVITY');
  assert.deepStrictEqual(r.allowed, ['EXPIRY_PIN']);
});

test('IV spike => EVENT_CHAOS, stand down', () => {
  const rc = new RegimeClassifier({ ivSpikeZ: 1.5 });
  // seed a low-IV baseline
  for (let i = 0; i < 8; i++) {
    rc.classify(
      { ready: true, flowState: 'CORRIDOR', netWriterFlow: 0, priceDelta: 0, peCentroid: 22900, ceCentroid: 23100, ceWalls: [], peWalls: [] },
      snap({ ts: tsAtIST('2026-06-15', 10, i), strikes: ladder({ 23000: [100, 100] }, { 23000: 12 }) })
    );
  }
  // now a big IV jump
  const r = rc.classify(
    { ready: true, flowState: 'CORRIDOR', netWriterFlow: 0, priceDelta: 0, peCentroid: 22900, ceCentroid: 23100, ceWalls: [], peWalls: [] },
    snap({ ts: tsAtIST('2026-06-15', 10, 9), strikes: ladder({ 23000: [100, 100] }, { 23000: 30 }) })
  );
  assert.strictEqual(r.regime, 'EVENT_CHAOS');
  assert.deepStrictEqual(r.allowed, []);
});

test('one-sided put writing + support ratcheting => TREND_BULL', () => {
  const rc = new RegimeClassifier({ trendNWF: 0.8 });
  // first call seeds lastPeCentroid
  rc.classify(
    { ready: true, flowState: 'BULL_CONFIRM', netWriterFlow: 1.5, priceDelta: 10, peCentroid: 22900, ceCentroid: 23100, ceWalls: [], peWalls: [] },
    snap({ strikes: ladder({ 23000: [100, 100] }) })
  );
  // second: support centroid moved up, price up, strong NWF
  const r = rc.classify(
    { ready: true, flowState: 'BULL_CONFIRM', netWriterFlow: 1.5, priceDelta: 10, peCentroid: 22950, ceCentroid: 23100, ceWalls: [], peWalls: [] },
    snap({ spot: 23010, strikes: ladder({ 23000: [100, 100] }) })
  );
  assert.strictEqual(r.regime, 'TREND_BULL');
  assert.ok(r.allowed.includes('WRITER_MIGRATION_CONTINUATION'));
});

test('two-sided writing => CORRIDOR allowing the fade', () => {
  const rc = new RegimeClassifier();
  rc.classify(
    { ready: true, flowState: 'CORRIDOR', netWriterFlow: 0.1, priceDelta: 0, peCentroid: 22900, ceCentroid: 23100, ceWalls: [], peWalls: [] },
    snap({ strikes: ladder({ 23000: [100, 100] }) })
  );
  const r = rc.classify(
    { ready: true, flowState: 'CORRIDOR', netWriterFlow: 0.1, priceDelta: 0, peCentroid: 22900, ceCentroid: 23100, ceWalls: [], peWalls: [] },
    snap({ strikes: ladder({ 23000: [100, 100] }) })
  );
  assert.strictEqual(r.regime, 'CORRIDOR');
  assert.ok(r.allowed.includes('WALL_ABSORPTION_FADE'));
});
