const EVENT_TYPES = new Set([
  'TICK', 'TRADE', 'BOOK', 'CANDLE', 'OPTION_CHAIN',
  'OPEN_INTEREST', 'FUNDING', 'SETTLEMENT', 'INSTRUMENT_STATUS'
]);

function epochMs(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive epoch timestamp`);
  return n < 1e12 ? n * 1000 : n;
}

function createMarketEvent(input) {
  input = input || {};
  const type = String(input.type || '').toUpperCase();
  if (!EVENT_TYPES.has(type)) throw new Error(`unsupported market event type: ${type}`);
  const instrumentId = String(input.instrumentId || '').trim();
  const source = String(input.source || '').trim();
  if (!instrumentId || !source) throw new Error('instrumentId and source are required');

  const event = {
    version: 1,
    type,
    instrumentId,
    source,
    exchangeTs: epochMs(input.exchangeTs, 'exchangeTs'),
    receivedTs: epochMs(input.receivedTs || Date.now(), 'receivedTs'),
    sequence: input.sequence == null ? null : String(input.sequence),
    payload: Object.freeze({ ...(input.payload || {}) }),
    quality: Object.freeze({
      delayed: !!(input.quality && input.quality.delayed),
      indicative: !!(input.quality && input.quality.indicative),
      snapshot: !!(input.quality && input.quality.snapshot)
    })
  };
  if (event.receivedTs + 1000 < event.exchangeTs) throw new Error('receivedTs cannot precede exchangeTs');
  return Object.freeze(event);
}

module.exports = { createMarketEvent, EVENT_TYPES };
