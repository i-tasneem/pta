// signals/SignalPresentationService.js
class SignalPresentationService {
  constructor(redisSchema, eventBus, config) {
    this.schema = redisSchema;
    this.eventBus = eventBus;
    this.config = config.presentation;
  }

  async getSignal(signalId, includeDetails = false) {
    const keys = await this.eventBus.client.keys(`${this.schema.prefix}:signal:*:${signalId}`);
    if (keys.length === 0) return null;
    const signal = await this.eventBus.hgetall(keys[0]);
    if (!signal || Object.keys(signal).length === 0) return null;
    return this.formatSignal(signal, includeDetails);
  }

  async getSignalsForInstrument(instrument, includeDetails = false) {
    const active = await this.eventBus.hgetall(this.schema.activeSignal(instrument));
    const signals = [];
    if (active && Object.keys(active).length > 0) {
      signals.push(this.formatSignal(active, includeDetails));
    }
    return signals;
  }

  async getAllActiveSignals(includeDetails = false) {
    const keys = await this.eventBus.client.keys(`${this.schema.prefix}:signal:active:*`);
    const signals = [];
    for (const key of keys) {
      const signal = await this.eventBus.hgetall(key);
      if (signal && Object.keys(signal).length > 0) {
        signals.push(this.formatSignal(signal, includeDetails));
      }
    }
    return signals;
  }

  formatSignal(signal, includeDetails = false) {
    const entryZone = JSON.parse(signal.entryZone || '[]');
    const stopZone = JSON.parse(signal.stopZone || '[]');
    const targetZone = JSON.parse(signal.targetZone || '[]');

    const userFacing = {
      id: signal.id,
      instrument: signal.instrument,
      type: signal.type,
      direction: signal.direction,
      action: signal.direction === 'CE' ? 'BUY' : 'SELL',
      entry: this.formatZone(entryZone),
      stop: this.formatZone(stopZone),
      target: this.formatZone(targetZone),
      confidence: `${signal.confidence}%`,
      status: signal.state,
      triggeredAt: this.formatTimestamp(signal.triggeredAt),
      reason: signal.userReason || 'Strong Setup'
    };

    if (!includeDetails) {
      return userFacing;
    }

    const details = {
      trendAnalysis: this.safeParse(signal.trendAnalysis),
      oiAnalysis: this.safeParse(signal.oiAnalysis),
      volumeAnalysis: this.safeParse(signal.volumeAnalysis),
      regimeAnalysis: this.safeParse(signal.regimeAnalysis),
      liquidityAnalysis: this.safeParse(signal.liquidityAnalysis),
      gateResults: this.safeParse(signal.gateResults)
    };

    return { ...userFacing, details };
  }

  formatZone(zone) {
    if (!zone || zone.length === 0) return 'N/A';
    if (zone.length === 1 || zone[0] === zone[1]) return `₹ ${zone[0].toFixed(2)}`;
    return `₹ ${zone[0].toFixed(2)} - ₹ ${zone[1].toFixed(2)}`;
  }

  formatTimestamp(ts) {
    if (!ts) return '';
    return new Date(parseInt(ts)).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  safeParse(json) {
    if (!json || json === 'null') return {};
    try { return JSON.parse(json); } catch { return {}; }
  }
}

module.exports = SignalPresentationService;
