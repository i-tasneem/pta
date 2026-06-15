import { SessionPhase } from '../types';

// NSE session phases in IST (epoch ms in, phase out). Used to gate triggers
// (no fresh entries in the opening noise or the closing squaring-off).
export function sessionPhase(ts: number): SessionPhase {
  const istMinutes = (Math.floor(ts / 60000) + 330) % 1440; // UTC+5:30
  const hm = (h: number, m: number) => h * 60 + m;

  if (istMinutes < hm(9, 15)) return 'PRE';
  if (istMinutes < hm(9, 30)) return 'OPEN';
  if (istMinutes < hm(11, 0)) return 'MORNING';
  if (istMinutes < hm(13, 30)) return 'MIDDAY';
  if (istMinutes < hm(15, 0)) return 'AFTERNOON';
  if (istMinutes <= hm(15, 30)) return 'CLOSE';
  return 'POST';
}

// IST calendar date (YYYY-MM-DD) for an epoch-ms timestamp.
export function istDate(ts: number): string {
  return new Date(ts + 330 * 60000).toISOString().slice(0, 10);
}
