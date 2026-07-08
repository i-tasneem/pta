// scanner/MarketCalendar.js
// Per-exchange polling windows in IST. This answers "should we spend API
// budget on this instrument right now" — distinct from the engine's session
// PHASES (engine/src/structure/session.ts), which weight archetype fitness
// within an open session.
//
// Windows carry a 5-minute tail so the closing chain (settlement OI) is
// captured. Exchange holidays are NOT modeled: polling on a weekday holiday
// returns frozen chains, which the engine's staleness/flat handling already
// tolerates — same behavior the system has today.

const WINDOWS = {
  NSE: { startMin: 9 * 60 + 15, endMin: 15 * 60 + 35 },
  // MCX energy trades to 23:30 IST (23:55 during US winter time — the DST
  // variant is deliberately ignored here; the last winter minutes are low
  // value and the engine reads them as POST anyway).
  MCX: { startMin: 9 * 60 + 0, endMin: 23 * 60 + 35 }
};

// Day-of-week and minutes-of-day in IST for an epoch-ms timestamp.
function istClock(ts) {
  const shifted = new Date(ts + 330 * 60000);
  return { day: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
}

function isOpen(calendar, ts) {
  const win = WINDOWS[calendar];
  if (!win) return false;
  const { day, minutes } = istClock(ts);
  if (day === 0 || day === 6) return false; // Sunday/Saturday
  return minutes >= win.startMin && minutes <= win.endMin;
}

module.exports = { isOpen, WINDOWS };
