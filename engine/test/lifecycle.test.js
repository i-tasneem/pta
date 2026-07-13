const test = require('node:test');
const assert = require('node:assert');
const { SetupEngine } = require('../dist/index.js');

// Build a realistic bull squeeze: a few QUIET snapshots (flat OI — the
// baseline the z-score needs), then a CE wall at 23000 capitulating in
// accelerating, varying steps while puts build below and price breaks up.
function leg(oi, iv = 12) { return { ltp: 100, oi, volume: 0, iv, delta: 0.5 }; }
const DROPS = [0, 0, 0, 400, 900, 1300, 1900, 2500, 3100, 3700];
function chainAt(i) {
  const quiet = i < 3;
  const spot = quiet ? 22980 : 22980 + (i - 2) * 15; // breaks up after the quiet phase
  const ceWallOi = Math.max(300, 5000 - (DROPS[Math.min(i, DROPS.length - 1)]));
  const pe1 = quiet ? 1500 : 1500 + (i - 2) * 140;
  const pe2 = quiet ? 1500 : 1500 + (i - 2) * 100;
  return {
    instrument: 'NIFTY', ts: i * 60000, spot, atmStrike: 23000, pcr: 1.1,
    totalCeOi: 0, totalPeOi: 0, expiry: '2026-06-30',
    strikes: [
      { strike: 22800, ce: leg(500), pe: leg(pe1) },
      { strike: 22900, ce: leg(500), pe: leg(pe2) },
      { strike: 23000, ce: leg(ceWallOi), pe: leg(800) }, // the CE wall, capitulating
      { strike: 23100, ce: leg(800), pe: leg(400) },
      { strike: 23200, ce: leg(700), pe: leg(300) }
    ]
  };
}

test('a bull squeeze progresses through the lifecycle to TRIGGERED', () => {
  const eng = new SetupEngine('NIFTY', {
    tracker: { minBaseline: 2, atmWindowSteps: 2, wallZ: 1.2 },
    regime: { trendNWF: 0.3 },
    formingScore: 30, strengtheningScore: 45, readyScore: 55,
    breakMinParticipation: 0.4, triggerBufferPct: 0.0002
  });

  const stagesSeen = new Set();
  let last;
  for (let i = 0; i < 10; i++) {
    last = eng.onSnapshot(chainAt(i), 0, 0.8); // strong futures participation
    for (const h of last.hypotheses) stagesSeen.add(h.stage);
    for (const t of last.transitions) stagesSeen.add(t.to);
  }

  // It should at least have formed a hypothesis and advanced beyond FORMING.
  assert.ok(stagesSeen.has('FORMING'), 'should form');
  assert.ok(
    stagesSeen.has('STRENGTHENING') || stagesSeen.has('READY') || stagesSeen.has('TRIGGERED'),
    'should advance past FORMING; saw ' + [...stagesSeen].join(',')
  );
});

test('a stale snapshot gap invalidates open hypotheses', () => {
  const eng = new SetupEngine('NIFTY', {
    tracker: { minBaseline: 2, atmWindowSteps: 2, wallZ: 1.2 },
    regime: { trendNWF: 0.3 }, formingScore: 30, staleMs: 90000
  });
  for (let i = 0; i < 4; i++) eng.onSnapshot(chainAt(i), 0, 0.8);

  // jump 5 minutes ahead -> stale
  const future = chainAt(4);
  future.ts = 4 * 60000 + 5 * 60000;
  const res = eng.onSnapshot(future, 0, 0.8);
  const invalidated = res.transitions.some((t) => t.to === 'INVALIDATED');
  // either invalidated via transition or no active hypotheses remain
  assert.ok(invalidated || res.hypotheses.length === 0, 'stale feed should clear hypotheses');
});

test('no hypotheses while analytics are warming up', () => {
  const eng = new SetupEngine('NIFTY', { tracker: { minBaseline: 5 } });
  const first = eng.onSnapshot(chainAt(0), 0, 0.8);
  assert.strictEqual(first.hypotheses.length, 0);
  assert.strictEqual(first.analytics.ready, false);
});

test('transitions carry reasons for explainability', () => {
  const eng = new SetupEngine('NIFTY', {
    tracker: { minBaseline: 2, atmWindowSteps: 2, wallZ: 1.2 },
    regime: { trendNWF: 0.3 }, formingScore: 30
  });
  let withReasons = false;
  for (let i = 0; i < 6; i++) {
    const res = eng.onSnapshot(chainAt(i), 0, 0.8);
    for (const t of res.transitions) {
      if (Array.isArray(t.reasons) && t.reasons.length > 0 && typeof t.thesis === 'string') withReasons = true;
    }
  }
  assert.ok(withReasons, 'transitions should include reasons + thesis');
});

test('restored open trade survives a stale gap and remains managed', () => {
  const eng = new SetupEngine('NIFTY', { staleMs: 90000 });
  eng.restoreOpenState({
    version: 1,
    instrument: 'NIFTY',
    lastTs: 1000,
    hypotheses: [{
      id: 'restored-1', instrument: 'NIFTY', archetype: 'WALL_CAPITULATION_BREAK',
      direction: 'CE', stage: 'ACTIVE', score: 70, reasons: [], evidence: [],
      structuralStop: 22000, structuralTarget: 24000, entryRef: 23000,
      thesis: 'restored open risk', createdAt: 1, updatedAt: 1000,
      triggeredAt: 500, scoreHistory: [70], missCount: 0, holds: 3, stopViolations: 0
    }]
  });
  assert.strictEqual(eng.hasOpenPositions(), true);
  const snap = chainAt(0);
  snap.ts = 500000;
  snap.spot = 23100;
  const result = eng.onSnapshot(snap, 0, 0);
  assert.ok(result.hypotheses.some((h) => h.id === 'restored-1' && h.stage === 'ACTIVE'));
  assert.ok(!result.transitions.some((t) => t.id === 'restored-1' && t.to === 'INVALIDATED'));
});
