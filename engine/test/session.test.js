const test = require('node:test');
const assert = require('node:assert');
const { sessionPhase } = require('../dist/index.js');

// Epoch ms for an IST wall-clock time on a fixed weekday (Wed 2026-07-08).
const istTs = (h, m) => Date.UTC(2026, 6, 8, h, m) - 330 * 60000;

test('NSE calendar is the default and unchanged', () => {
  const cases = [
    [9, 14, 'PRE'],
    [9, 20, 'OPEN'],
    [10, 0, 'MORNING'],
    [12, 0, 'MIDDAY'],
    [14, 0, 'AFTERNOON'],
    [15, 15, 'CLOSE'],
    [15, 30, 'CLOSE'],
    [16, 0, 'POST']
  ];
  for (const [h, m, want] of cases) {
    assert.strictEqual(sessionPhase(istTs(h, m)), want, `NSE ${h}:${m}`);
    assert.strictEqual(sessionPhase(istTs(h, m), 'NSE'), want, `NSE explicit ${h}:${m}`);
  }
});

test('MCX calendar follows the energy liquidity clock', () => {
  const cases = [
    [8, 30, 'PRE'],
    [9, 10, 'OPEN'],
    [11, 0, 'MIDDAY'],     // thin Indian-only hours
    [14, 0, 'MIDDAY'],
    [15, 0, 'EU'],
    [19, 0, 'US_PRIME'],   // NYMEX + EIA windows
    [22, 0, 'LATE'],
    [23, 10, 'CLOSE'],
    [23, 30, 'CLOSE'],
    [23, 45, 'POST']
  ];
  for (const [h, m, want] of cases) {
    assert.strictEqual(sessionPhase(istTs(h, m), 'MCX'), want, `MCX ${h}:${m}`);
  }
});

test('NSE never emits MCX-only phases across the whole day', () => {
  const mcxOnly = new Set(['EU', 'US_PRIME', 'LATE']);
  for (let mins = 0; mins < 1440; mins += 5) {
    const phase = sessionPhase(istTs(0, 0) + mins * 60000, 'NSE');
    assert.ok(!mcxOnly.has(phase), `NSE emitted ${phase} at +${mins}min`);
  }
});
