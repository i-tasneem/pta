const test = require('node:test');
const assert = require('node:assert');
const { WEIGHTS, scoreEvidence, zStrength, buildRiskPlan, premiumATRfromUnderlying } = require('../dist/index.js');

test('weights sum to 100', () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, 100);
});

test('full-strength evidence across all components scores 100', () => {
  const ev = Object.keys(WEIGHTS).map((component) => ({ component, strength: 1, detail: component }));
  assert.strictEqual(scoreEvidence(ev).score, 100);
});

test('partial evidence normalizes to the achievable weight and collects reasons', () => {
  const ev = [
    { component: 'wallBehavior', strength: 1, detail: 'wall capitulating' },   // 25 of 25
    { component: 'writerFlow', strength: 0.5, detail: 'flow confirming' },     // 10 of 20
    { component: 'futuresParticipation', strength: 0, detail: 'no volume' }    // 0 of 15
  ];
  const r = scoreEvidence(ev);
  // raw 35 over an achievable 60 -> 58.3; a missing component reduces the
  // achievable weight instead of silently capping the archetype's ceiling
  assert.strictEqual(r.score, 58.3);
  assert.strictEqual(r.rawScore, 35);
  assert.strictEqual(r.achievableWeight, 60);
  assert.deepStrictEqual(r.reasons, ['wall capitulating', 'flow confirming']);
});

test('zStrength saturates', () => {
  assert.strictEqual(zStrength(0), 0);
  assert.ok(Math.abs(zStrength(1.5) - 0.5) < 1e-9);
  assert.strictEqual(zStrength(6), 1);
});

test('CE risk plan: structural levels translated to premium space', () => {
  // entry 23000, stop 22950 (-50), target 23120 (+120); ATM CE premium 100,
  // delta 0.5, gamma 0.001, premiumATR 25
  const plan = buildRiskPlan({
    direction: 'CE',
    entryUnderlying: 23000,
    structuralStop: 22950,
    structuralTarget: 23120,
    optionPremium: 100,
    deltaSigned: 0.5,
    gamma: 0.001,
    premiumATR: 25
  });
  // stopPremium ~ 100 + (0.5*-50 + 0.5*0.001*2500) = 100 -25 +1.25 = 76.25
  assert.ok(Math.abs(plan.stopPremium - 76.25) < 0.01, 'stop ' + plan.stopPremium);
  // targetPremium ~ 100 + (0.5*120 + 0.5*0.001*14400) = 100 +60 +7.2 = 167.2
  assert.ok(Math.abs(plan.targetPremium - 167.2) < 0.01, 'target ' + plan.targetPremium);
  // reward 67.2 / risk 23.75 = 2.83
  assert.ok(plan.rr > 2.75 && plan.rr < 2.9, 'rr ' + plan.rr);
  assert.strictEqual(plan.valid, true);
});

test('PE risk plan: down move grows the put premium', () => {
  const plan = buildRiskPlan({
    direction: 'PE',
    entryUnderlying: 23000,
    structuralStop: 23050,   // adverse for a put = up
    structuralTarget: 22880, // favorable = down
    optionPremium: 100,
    deltaSigned: -0.5,
    gamma: 0.001,
    premiumATR: 25
  });
  assert.ok(plan.stopPremium < 100, 'put loses value on up move');
  assert.ok(plan.targetPremium > 100, 'put gains value on down move');
  assert.strictEqual(plan.valid, true);
});

test('risk plan rejects sub-threshold R:R', () => {
  const plan = buildRiskPlan({
    direction: 'CE', entryUnderlying: 23000, structuralStop: 22950, structuralTarget: 23010,
    optionPremium: 100, deltaSigned: 0.5, gamma: 0, premiumATR: 25, minRR: 1.8
  });
  assert.strictEqual(plan.valid, false);
  assert.match(plan.reason, /R:R/);
});

test('premiumATRfromUnderlying', () => {
  assert.strictEqual(premiumATRfromUnderlying(50, -0.5), 25);
});
