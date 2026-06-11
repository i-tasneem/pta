// signals/SignalTypes.js
const SignalTypes = {
  TREND_CE: 'TREND_CE',
  TREND_PE: 'TREND_PE',
  BREAKOUT_CE: 'BREAKOUT_CE',
  BREAKOUT_PE: 'BREAKOUT_PE',
  REVERSAL_CE: 'REVERSAL_CE',
  REVERSAL_PE: 'REVERSAL_PE',
  RANGE_CE: 'RANGE_CE',
  RANGE_PE: 'RANGE_PE',
  WATCHLIST_SETUP: 'WATCHLIST_SETUP',
  WAIT: 'WAIT',
  NO_TRADE: 'NO_TRADE'
};

const SignalStates = {
  NEW: 'NEW',
  ACTIVE: 'ACTIVE',
  WATCHING: 'WATCHING',
  TRIGGERED: 'TRIGGERED',
  HOLD: 'HOLD',
  ADD: 'ADD',
  PARTIAL_EXIT: 'PARTIAL_EXIT',
  EXIT: 'EXIT',
  ABORTED: 'ABORTED',
  ARCHIVED: 'ARCHIVED'
};

const UserReasons = {
  TREND: 'Strong Trend',
  BREAKOUT: 'Breakout Setup',
  REVERSAL: 'Reversal Setup',
  RANGE: 'Range Setup',
  MOMENTUM: 'Momentum Build-up',
  HIGH_CONVICTION: 'High Conviction',
  TREND_CONTINUATION: 'Trend Continuation'
};

module.exports = { SignalTypes, SignalStates, UserReasons };
