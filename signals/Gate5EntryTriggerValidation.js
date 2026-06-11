// signals/Gate5EntryTriggerValidation.js
const DecisionGate = require('./DecisionGate');

class Gate5EntryTriggerValidation extends DecisionGate {
  constructor(config) {
    super('Gate5_EntryTriggerValidation', 5);
    this.config = config;
  }

  async evaluate(context) {
    const { state, tick, opportunity, chain } = context;
    const direction = opportunity.direction;
    const ltp = parseFloat(tick.ltp || 0);
    const vwap = parseFloat(tick.vwap || state.vwap_5m || 0);

    // VWAP cross check
    const vwapCross = direction === 'CE' ? ltp > vwap : ltp < vwap;
    if (!vwapCross) {
      return this.createFailResult(`Price not crossed VWAP in ${direction} direction`);
    }

    // OI wall break check
    const wallBreak = state.wallBreak;
    if (wallBreak && wallBreak !== 'null') {
      const wb = JSON.parse(wallBreak);
      if (wb.direction !== direction) {
        return this.createFailResult(`Wall break direction ${wb.direction} conflicts with ${direction}`);
      }
    }

    // Spread check on ATM option
    const spread = await this.getATMSpread(chain, direction, state.atmStrike);
    if (spread > this.config.maxSpread) {
      return this.createFailResult(`ATM option spread ${spread.toFixed(2)}% too wide (max ${this.config.maxSpread}%)`);
    }

    // Volume confirmation
    const volumeStrength = parseFloat(state.volumeStrength_5m || 0);
    if (volumeStrength < this.config.minVolumeConfirm) {
      return this.createFailResult(`Volume not confirming: ${volumeStrength.toFixed(1)} < ${this.config.minVolumeConfirm}`);
    }

    return this.createPassResult();
  }

  async getATMSpread(chain, direction, atmStrike) {
    if (!chain || !atmStrike) return 0;
    const key = direction === 'CE' ? `ce:${atmStrike}` : `pe:${atmStrike}`;
    const optionData = chain[key];
    if (!optionData) return 0;
    try {
      const data = JSON.parse(optionData);
      const ltp = data.ltp || 1;
      const spread = ((data.ask || 0) - (data.bid || 0)) / ltp * 100;
      return spread;
    } catch {
      return 0;
    }
  }
}

module.exports = Gate5EntryTriggerValidation;
