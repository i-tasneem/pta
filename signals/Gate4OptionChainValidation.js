// signals/Gate4OptionChainValidation.js
const DecisionGate = require('./DecisionGate');

class Gate4OptionChainValidation extends DecisionGate {
  constructor(config) {
    super('Gate4_OptionChainValidation', 4);
    this.config = config;
  }

  async evaluate(context) {
    const { state, tick, opportunity } = context;
    const direction = opportunity.direction;

    // PCR trend
    const pcrTrend = state.pcrTrend || 'NEUTRAL';
    const pcrConfirming = direction === 'CE' ? pcrTrend === 'FALLING' : pcrTrend === 'RISING';
    if (!pcrConfirming) {
      return this.createFailResult(`PCR trend ${pcrTrend} does not confirm ${direction}`);
    }

    // OI velocity
    const oiVelocity = parseFloat(state.oiVelocity || 0);
    const oiConfirming = direction === 'CE' ? oiVelocity > this.config.minOIVelocity : oiVelocity < -this.config.minOIVelocity;
    if (!oiConfirming) {
      return this.createFailResult(`OI velocity ${oiVelocity.toFixed(0)} does not confirm ${direction}`);
    }

    // Wall pinning check
    const ltp = parseFloat(tick.ltp || 0);
    const atr = parseFloat(state.atr_5m || 50);
    const supportWalls = JSON.parse(state.supportWalls || '[]');
    const resistanceWalls = JSON.parse(state.resistanceWalls || '[]');

    if (direction === 'CE') {
      const nearestResistance = resistanceWalls[0];
      if (nearestResistance && Math.abs(ltp - nearestResistance.strike) < atr * this.config.wallPinDistance) {
        return this.createFailResult(`Price pinned near resistance wall: ${nearestResistance.strike}`);
      }
    } else {
      const nearestSupport = supportWalls[0];
      if (nearestSupport && Math.abs(ltp - nearestSupport.strike) < atr * this.config.wallPinDistance) {
        return this.createFailResult(`Price pinned near support wall: ${nearestSupport.strike}`);
      }
    }

    // Fresh buildup check
    const oiPattern = state.oiPattern || 'NEUTRAL';
    const unfavorablePatterns = ['LONG_UNWINDING', 'SHORT_COVERING'];
    if (unfavorablePatterns.includes(oiPattern)) {
      return this.createFailResult(`OI pattern indicates weakness: ${oiPattern}`);
    }

    return this.createPassResult();
  }
}

module.exports = Gate4OptionChainValidation;
