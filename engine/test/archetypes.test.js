const test = require('node:test');
const assert = require('node:assert');
const { evaluateArchetypes, scoreEvidence } = require('../dist/index.js');

function analytics(over) {
  return {
    ts: 0, vCE: 0, vPE: 0, zvCE: 0, zvPE: 0, netWriterFlow: 0,
    flowState: 'NEUTRAL', priceDelta: 0, easeOfMovement: 0,
    ceWalls: [], peWalls: [], ceCentroid: 0, peCentroid: 0, ready: true, ...over
  };
}
function regime(over) {
  return {
    regime: 'UNCLEAR', allowed: [], reason: '', sessionPhase: 'MORNING',
    atmIV: 12, isExpiryDay: false, basis: 0,
    corridor: { support: null, resistance: null, width: null, widthPct: null }, ...over
  };
}
function snap(over) {
  return { instrument: 'NIFTY', ts: 0, spot: 23000, atmStrike: 23000, pcr: 1,
    totalCeOi: 0, totalPeOi: 0, expiry: '2026-06-16', strikes: [], ...over };
}

test('wall capitulation break fires bull with CE direction and stop below entry', () => {
  const ctx = {
    analytics: analytics({ flowState: 'SQUEEZE_FUEL_BULL', zvCE: -2.5, netWriterFlow: 1.8 }),
    regime: regime({ regime: 'TREND_BULL', allowed: ['WALL_CAPITULATION_BREAK'],
      corridor: { support: 22800, resistance: 23000, width: 200, widthPct: 0.0087 } }),
    snapshot: snap({ spot: 23010 }),
    futParticipation: 0.8
  };
  const sigs = evaluateArchetypes(ctx);
  assert.strictEqual(sigs.length, 1);
  const s = sigs[0];
  assert.strictEqual(s.archetype, 'WALL_CAPITULATION_BREAK');
  assert.strictEqual(s.direction, 'CE');
  assert.ok(s.structuralStop < s.entryRef, 'stop below entry for a call');
  assert.ok(s.structuralTarget > s.entryRef, 'target above entry');
  const score = scoreEvidence(s.evidence).score;
  assert.ok(score > 50, 'textbook break should score > 50, got ' + score);
});

test('archetype does not fire when its regime is not allowed', () => {
  const ctx = {
    analytics: analytics({ flowState: 'SQUEEZE_FUEL_BULL', zvCE: -2.5, netWriterFlow: 1.8 }),
    regime: regime({ regime: 'CORRIDOR', allowed: ['WALL_ABSORPTION_FADE'],
      corridor: { support: 22800, resistance: 23000, width: 200, widthPct: 0.0087 } }),
    snapshot: snap({ spot: 23010 })
  };
  const sigs = evaluateArchetypes(ctx);
  assert.ok(!sigs.some((x) => x.archetype === 'WALL_CAPITULATION_BREAK'));
});

test('absorption fade at support fires CE toward center', () => {
  const ctx = {
    analytics: analytics({ flowState: 'CORRIDOR', vPE: 500, vCE: 100 }),
    regime: regime({ regime: 'CORRIDOR', allowed: ['WALL_ABSORPTION_FADE'],
      corridor: { support: 22900, resistance: 23300, width: 400, widthPct: 0.017 } }),
    snapshot: snap({ spot: 22910 })
  };
  const sigs = evaluateArchetypes(ctx);
  const fade = sigs.find((x) => x.archetype === 'WALL_ABSORPTION_FADE');
  assert.ok(fade, 'fade should fire');
  assert.strictEqual(fade.direction, 'CE');
  assert.ok(fade.structuralTarget > fade.entryRef);
  assert.ok(fade.structuralStop < fade.entryRef);
});

test('writer migration continuation fires in trend', () => {
  const ctx = {
    analytics: analytics({ netWriterFlow: 1.5, peCentroid: 22950 }),
    regime: regime({ regime: 'TREND_BULL', allowed: ['WRITER_MIGRATION_CONTINUATION'],
      corridor: { support: 22850, resistance: 23200, width: 350, widthPct: 0.015 } }),
    snapshot: snap({ spot: 23000 }),
    futParticipation: 0.6
  };
  const sigs = evaluateArchetypes(ctx);
  const cont = sigs.find((x) => x.archetype === 'WRITER_MIGRATION_CONTINUATION');
  assert.ok(cont);
  assert.strictEqual(cont.direction, 'CE');
});

test('expiry pin fades toward max pain', () => {
  const ctx = {
    analytics: analytics({}),
    regime: regime({ regime: 'EXPIRY_GRAVITY', allowed: ['EXPIRY_PIN'], sessionPhase: 'AFTERNOON', isExpiryDay: true }),
    snapshot: snap({ spot: 23100, maxPain: 23000 })
  };
  const sigs = evaluateArchetypes(ctx);
  const pin = sigs.find((x) => x.archetype === 'EXPIRY_PIN');
  assert.ok(pin);
  assert.strictEqual(pin.direction, 'PE'); // spot above max pain -> fade down
  assert.strictEqual(pin.structuralTarget, 23000);
});

test('nothing fires before warmup', () => {
  const ctx = {
    analytics: analytics({ ready: false, flowState: 'SQUEEZE_FUEL_BULL', zvCE: -3, netWriterFlow: 2 }),
    regime: regime({ regime: 'TREND_BULL', allowed: ['WALL_CAPITULATION_BREAK', 'WRITER_MIGRATION_CONTINUATION'],
      corridor: { support: 22800, resistance: 23000, width: 200, widthPct: 0.0087 } }),
    snapshot: snap({ spot: 23010 })
  };
  assert.strictEqual(evaluateArchetypes(ctx).length, 0);
});
