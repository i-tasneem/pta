const test = require('node:test');
const assert = require('node:assert');
const ChainScheduler = require('../scanner/ChainScheduler');
const MarketCalendar = require('../scanner/MarketCalendar');

const alwaysOpen = () => true;

// Drive pick() with a simulated clock in fixed steps, recording fetches.
function simulate(sched, { stepMs, untilMs, startMs = 0 }) {
  const picks = [];
  for (let t = startMs; t <= untilMs; t += stepMs) {
    const e = sched.pick(t);
    if (e) picks.push({ symbol: e.symbol, t });
  }
  return picks;
}

test('index parity: 6 instruments at 21s cadence saturate the conservative budget fairly', () => {
  const sched = new ChainScheduler({ budgetRps: 1 / 3.5, isOpen: alwaysOpen, now: () => 0 });
  const symbols = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
  for (const s of symbols) sched.add({ symbol: s, cadenceMs: 21000 });

  const picks = simulate(sched, { stepMs: 500, untilMs: 210000 });

  // ~one fetch per 3.5s overall (float-rounding slack allowed)
  assert.ok(picks.length >= 55 && picks.length <= 62, `total picks ${picks.length}`);

  for (const s of symbols) {
    const times = picks.filter((p) => p.symbol === s).map((p) => p.t);
    assert.ok(times.length >= 9 && times.length <= 11, `${s} fetched ${times.length}x in 210s`);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] - times[i - 1] >= 21000, `${s} fetched inside its cadence`);
    }
  }
});

test('per-unique 3s floor binds even when cadence and budget would allow faster', () => {
  const sched = new ChainScheduler({ budgetRps: 5, isOpen: alwaysOpen, now: () => 0 });
  sched.add({ symbol: 'CRUDEOIL', cadenceMs: 1000 });

  const picks = simulate(sched, { stepMs: 100, untilMs: 10000 });
  const times = picks.map((p) => p.t);
  assert.ok(times.length >= 3 && times.length <= 4, `picks ${times.length}`);
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] - times[i - 1] >= 3000, 'unique-underlying floor violated');
  }
});

test('closed exchanges are never polled and cost no budget', () => {
  const openOnlyMcx = (calendar) => calendar === 'MCX';
  const sched = new ChainScheduler({ budgetRps: 1 / 3.5, isOpen: openOnlyMcx, now: () => 0 });
  sched.add({ symbol: 'NIFTY', calendar: 'NSE', cadenceMs: 21000 });
  sched.add({ symbol: 'CRUDEOIL', calendar: 'MCX', cadenceMs: 15000 });
  sched.add({ symbol: 'NATURALGAS', calendar: 'MCX', cadenceMs: 15000 });

  const picks = simulate(sched, { stepMs: 500, untilMs: 60000 });
  assert.ok(picks.length > 0, 'MCX should be polled');
  assert.ok(picks.every((p) => p.symbol !== 'NIFTY'), 'closed NSE must not be polled');

  // After NSE close the two MCX chains split the whole budget: each near its
  // own 15s cadence rather than a shared round-robin crawl.
  const crude = picks.filter((p) => p.symbol === 'CRUDEOIL');
  assert.ok(crude.length >= 3, `CRUDEOIL only fetched ${crude.length}x in 60s`);
});

test('most-overdue instrument (relative to its cadence) goes first', () => {
  const sched = new ChainScheduler({ budgetRps: 1 / 3.5, isOpen: alwaysOpen, now: () => 0 });
  sched.add({ symbol: 'A', cadenceMs: 21000 });
  sched.add({ symbol: 'B', cadenceMs: 21000 });

  const first = sched.pick(1000);
  assert.ok(first, 'one instrument picked at boot');
  const starved = first.symbol === 'A' ? 'B' : 'A';

  // Long past both cadences the never-fetched one has the larger overdue ratio.
  const next = sched.pick(30000);
  assert.strictEqual(next.symbol, starved);
});

test('budget tokens do not accumulate while everything is closed', () => {
  let open = false;
  const sched = new ChainScheduler({ budgetRps: 1 / 3.5, isOpen: () => open, now: () => 0 });
  sched.add({ symbol: 'NIFTY', cadenceMs: 21000 });

  assert.strictEqual(sched.pick(60000), null, 'closed: nothing picked');
  open = true;
  assert.ok(sched.pick(61000), 'first pick on open');
  assert.strictEqual(sched.pick(61500), null, 'no burst from hoarded weekend tokens');
});

test('pause() stops all picking and resume does not burst', () => {
  const sched = new ChainScheduler({ budgetRps: 5, isOpen: alwaysOpen, now: () => 0 });
  sched.add({ symbol: 'A', cadenceMs: 1000 });
  assert.ok(sched.pick(0), 'normal pick before pause');

  sched.pause(60000); // broker 805 — cool off
  assert.strictEqual(sched.pick(30000), null, 'paused mid-window');
  assert.strictEqual(sched.pick(60001), null, 'tokens drained — no burst at resume');
  assert.ok(sched.pick(61000), 'resumes after refill');
});

test('MarketCalendar: NSE and MCX windows in IST, weekends closed', () => {
  const istTs = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi) - 330 * 60000;
  // Wed 2026-07-08
  assert.ok(MarketCalendar.isOpen('NSE', istTs(2026, 6, 8, 10, 0)));
  assert.ok(!MarketCalendar.isOpen('NSE', istTs(2026, 6, 8, 9, 0)));
  assert.ok(!MarketCalendar.isOpen('NSE', istTs(2026, 6, 8, 16, 0)));
  assert.ok(MarketCalendar.isOpen('MCX', istTs(2026, 6, 8, 22, 0)));
  assert.ok(MarketCalendar.isOpen('MCX', istTs(2026, 6, 8, 9, 5)));
  assert.ok(!MarketCalendar.isOpen('MCX', istTs(2026, 6, 8, 23, 40)));
  // Sat 2026-07-11 / Sun 2026-07-12
  assert.ok(!MarketCalendar.isOpen('NSE', istTs(2026, 6, 11, 10, 0)));
  assert.ok(!MarketCalendar.isOpen('MCX', istTs(2026, 6, 12, 22, 0)));
  // Unknown calendar never opens
  assert.ok(!MarketCalendar.isOpen('NYSE', istTs(2026, 6, 8, 10, 0)));
});
