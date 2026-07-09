// signals/McxEvents.js
// Scheduled-event stand-downs for MCX energy options (design §2.2). MCX
// writers pin effectively all day and then get steamrolled by US data — the
// engine must not TRIGGER a fresh entry into a known release:
//
//   EIA crude inventories:  Wednesday 10:30 ET
//   EIA natural gas storage: Thursday 10:30 ET
//
// 10:30 ET = 20:00 IST during US daylight time, 21:00 IST in US winter.
// Stand-down window: T-45min .. T+15min. Only fresh triggers are blocked —
// existing setups keep evaluating (invalidation logic stays live).
//
// OPEC+ and other ad-hoc events are NOT modeled (manual/deferred).

// US daylight saving: 2nd Sunday of March 02:00 → 1st Sunday of November.
// Computed on the UTC calendar (exact hour boundaries around the switch are
// irrelevant at our 60-minute resolution).
function isUsDst(ts) {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(year, month, 1));
    const offset = (7 - first.getUTCDay()) % 7;
    return Date.UTC(year, month, 1 + offset + (n - 1) * 7, 7); // ~02:00 local ET
  };
  const dstStart = nthSunday(2, 2);  // second Sunday of March
  const dstEnd = nthSunday(10, 1);   // first Sunday of November
  return ts >= dstStart && ts < dstEnd;
}

// Weekly EIA schedule per underlying. day: IST weekday (0=Sun..6=Sat).
const WEEKLY = {
  CRUDEOIL: [{ day: 3, label: 'EIA crude inventories' }],
  NATURALGAS: [{ day: 4, label: 'EIA natural gas storage' }]
};

const PRE_MS = 45 * 60000;
const POST_MS = 15 * 60000;

// IST weekday + minutes for an epoch ts.
function istClock(ts) {
  const shifted = new Date(ts + 330 * 60000);
  return {
    day: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    msIntoDay: (shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds()) * 1000
  };
}

// Returns the active stand-down label, or null. `symbol` is the SIGNAL
// underlying (CRUDEOIL / NATURALGAS).
function standDown(symbol, ts = Date.now()) {
  const events = WEEKLY[symbol];
  if (!events) return null;

  const eventMinutesIst = isUsDst(ts) ? 20 * 60 : 21 * 60; // 20:00 / 21:00 IST
  const { day, msIntoDay } = istClock(ts);
  const eventMs = eventMinutesIst * 60000;

  for (const ev of events) {
    if (ev.day !== day) continue;
    if (msIntoDay >= eventMs - PRE_MS && msIntoDay <= eventMs + POST_MS) {
      return ev.label;
    }
  }
  return null;
}

module.exports = { standDown, isUsDst };
