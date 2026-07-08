import { SessionPhase } from '../types';

// Session phases per exchange calendar in IST (epoch ms in, phase out). Used
// to gate triggers (no fresh entries in the opening noise or the closing
// squaring-off) and to weight archetype session-fitness.
export type CalendarId = 'NSE' | 'MCX';

const hm = (h: number, m: number) => h * 60 + m;

// NSE equity/index day session 09:15–15:30.
function nsePhase(istMinutes: number): SessionPhase {
  if (istMinutes < hm(9, 15)) return 'PRE';
  if (istMinutes < hm(9, 30)) return 'OPEN';
  if (istMinutes < hm(11, 0)) return 'MORNING';
  if (istMinutes < hm(13, 30)) return 'MIDDAY';
  if (istMinutes < hm(15, 0)) return 'AFTERNOON';
  if (istMinutes <= hm(15, 30)) return 'CLOSE';
  return 'POST';
}

// MCX energy session 09:00–23:30 IST (23:55 during US winter time — the last
// 25 winter minutes read POST, which only suppresses fresh entries there).
// The clock that matters is exogenous: thin Indian-only hours until Europe
// arrives mid-afternoon, prime liquidity when the US trades (NYMEX hours +
// EIA releases land 18:00–21:00 IST), squaring into 23:30.
function mcxPhase(istMinutes: number): SessionPhase {
  if (istMinutes < hm(9, 0)) return 'PRE';
  if (istMinutes < hm(9, 30)) return 'OPEN';      // NYMEX-overnight gap digestion
  if (istMinutes < hm(14, 30)) return 'MIDDAY';   // thin Indian day — pin/fade territory
  if (istMinutes < hm(18, 0)) return 'EU';        // Europe/Brent flow arrives
  if (istMinutes < hm(21, 0)) return 'US_PRIME';  // deepest volume; EIA windows
  if (istMinutes < hm(23, 0)) return 'LATE';
  if (istMinutes <= hm(23, 30)) return 'CLOSE';
  return 'POST';
}

export function sessionPhase(ts: number, calendar: CalendarId = 'NSE'): SessionPhase {
  const istMinutes = (Math.floor(ts / 60000) + 330) % 1440; // UTC+5:30
  return calendar === 'MCX' ? mcxPhase(istMinutes) : nsePhase(istMinutes);
}

// IST calendar date (YYYY-MM-DD) for an epoch-ms timestamp.
export function istDate(ts: number): string {
  return new Date(ts + 330 * 60000).toISOString().slice(0, 10);
}
