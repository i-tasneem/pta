const test = require('node:test');
const assert = require('node:assert');
const { standDown, isUsDst } = require('../signals/McxEvents');

// Epoch ms for an IST wall-clock time on a given date.
const istTs = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi) - 330 * 60000;

test('US DST boundaries', () => {
  assert.ok(isUsDst(Date.UTC(2026, 6, 9)), 'July is DST');
  assert.ok(!isUsDst(Date.UTC(2026, 0, 15)), 'January is not');
  assert.ok(!isUsDst(Date.UTC(2026, 11, 1)), 'December is not');
  assert.ok(isUsDst(Date.UTC(2026, 2, 20)), 'late March is DST');
  assert.ok(!isUsDst(Date.UTC(2026, 2, 5)), 'early March is not');
});

test('EIA natgas stand-down on a summer Thursday (20:00 IST event)', () => {
  // 2026-07-09 is a Thursday
  assert.strictEqual(standDown('NATURALGAS', istTs(2026, 6, 9, 18, 0)), null, 'well before');
  assert.match(standDown('NATURALGAS', istTs(2026, 6, 9, 19, 20)) || '', /natural gas/, 'T-40m');
  assert.match(standDown('NATURALGAS', istTs(2026, 6, 9, 20, 10)) || '', /natural gas/, 'T+10m');
  assert.strictEqual(standDown('NATURALGAS', istTs(2026, 6, 9, 20, 20)), null, 'after window');
  assert.strictEqual(standDown('CRUDEOIL', istTs(2026, 6, 9, 19, 30)), null, 'crude is Wednesday, not Thursday');
});

test('EIA crude stand-down on a summer Wednesday', () => {
  // 2026-07-08 is a Wednesday
  assert.match(standDown('CRUDEOIL', istTs(2026, 6, 8, 19, 30)) || '', /crude/);
  assert.strictEqual(standDown('NATURALGAS', istTs(2026, 6, 8, 19, 30)), null);
});

test('winter shifts the event to 21:00 IST', () => {
  // 2026-12-09 is a Wednesday (US winter time)
  assert.strictEqual(standDown('CRUDEOIL', istTs(2026, 11, 9, 19, 30)), null, '19:30 is outside the winter window');
  assert.match(standDown('CRUDEOIL', istTs(2026, 11, 9, 20, 30)) || '', /crude/, 'T-30m of 21:00');
});

test('unknown symbols never stand down', () => {
  assert.strictEqual(standDown('NIFTY', istTs(2026, 6, 9, 19, 30)), null);
});
