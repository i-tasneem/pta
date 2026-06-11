// signals/EntryTriggerEngine.js
const Gate1RegimeValidation = require('./Gate1RegimeValidation');
const Gate2TrendValidation = require('./Gate2TrendValidation');
const Gate3MomentumValidation = require('./Gate3MomentumValidation');
const Gate4OptionChainValidation = require('./Gate4OptionChainValidation');
const Gate5EntryTriggerValidation = require('./Gate5EntryTriggerValidation');
const Gate6RankingValidation = require('./Gate6RankingValidation');
const { UserReasons } = require('./SignalTypes');

class EntryTriggerEngine {
  constructor(eventBus, redisSchema, config) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.config = config.gates;
    this.gates = [
      new Gate1RegimeValidation(this.config.gate1),
      new Gate2TrendValidation(this.config.gate2),
      new Gate3MomentumValidation(this.config.gate3),
      new Gate4OptionChainValidation(this.config.gate4),
      new Gate5EntryTriggerValidation(this.config.gate5),
      new Gate6RankingValidation(this.config.gate6)
    ];
    this.consumerGroup = 'cg-trigger';
  }

  async initialize() {
    await this.eventBus.createConsumerGroup(this.consumerGroup, '$');
  }

  async start() {
    this.running = true;
    this.processEvents();
  }

  async stop() {
    this.running = false;
  }

  async processEvents() {
    while (this.running) {
      try {
        const messages = await this.eventBus.readGroup(this.consumerGroup, 'trigger-1', 10, 1000);
        if (!messages || messages.length === 0) continue;

        for (const stream of messages) {
          for (const message of stream.messages) {
            await this.handleEvent(message.message);
            await this.eventBus.acknowledge(this.consumerGroup, message.id);
          }
        }
      } catch (err) {
        console.error('EntryTriggerEngine error:', err.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async handleEvent(event) {
    if (event.type === 'opportunity:score') {
      const data = JSON.parse(event.data || '{}');
      if (data.state === 'HIGH_POTENTIAL' || data.score >= this.config.gate6.minScore) {
        await this.evaluate(data.instrument || event.instrument);
      }
    }
  }

  async evaluate(instrument) {
    const opportunity = await this.eventBus.hgetall(this.schema.opportunity(instrument));
    const state = await this.eventBus.hgetall(this.schema.marketState(instrument));
    const chain = await this.eventBus.hgetall(this.schema.optionChain(instrument));
    const tick = await this.eventBus.hgetall(this.schema.tick(instrument));

    if (!opportunity || Object.keys(opportunity).length === 0) return;

    const context = { instrument, opportunity, state, chain, tick, eventBus: this.eventBus, schema: this.schema };
    const gateResults = [];

    for (let i = 0; i < this.gates.length; i++) {
      const gate = this.gates[i];
      const result = await gate.evaluate(context);
      gateResults.push({ gate: i + 1, pass: result.pass, reason: result.reason });

      if (!result.pass) {
        await this.eventBus.publish('gate:failed', instrument, { gate: i + 1, reason: result.reason });
        return { triggered: false, failedAtGate: i + 1, reason: result.reason, state: this.mapGateToState(i + 1) };
      }
    }

    const signal = this.generateSignal(context, gateResults);
    await this.eventBus.hset(this.schema.signal(instrument, signal.id), signal);
    await this.eventBus.hset(this.schema.activeSignal(instrument), signal);
    await this.eventBus.publish('opportunity:trigger', instrument, signal);

    return { triggered: true, signal };
  }

  generateSignal(context, gateResults) {
    const { instrument, opportunity, state, tick } = context;
    const direction = opportunity.direction;
    const score = parseFloat(opportunity.score || 0);

    let type = 'TREND';
    if (parseFloat(state.breakoutProbability || 0) > 70) type = 'BREAKOUT';
    else if (parseFloat(state.reversalProbability || 0) > 70) type = 'REVERSAL';
    else if (state.regime === 'RANGE_BOUND') type = 'RANGE';

    const signalType = `${type}_${direction}`;
    const atr = parseFloat(state.atr_5m || 50);
    const ltp = parseFloat(tick.ltp || 0);

    const entryZone = direction === 'CE' ? [ltp, ltp + atr * 0.3] : [ltp - atr * 0.3, ltp];
    const stopZone = direction === 'CE' ? [ltp - atr * 1.5, ltp - atr * 1.2] : [ltp + atr * 1.2, ltp + atr * 1.5];
    const targetZone = direction === 'CE' ? [ltp + atr * 2.0, ltp + atr * 3.0] : [ltp - atr * 3.0, ltp - atr * 2.0];

    const userReason = UserReasons[type] || 'Strong Setup';

    return {
      id: `${instrument}_${signalType}_${Date.now()}`,
      instrument,
      type: signalType,
      direction,
      score,
      confidence: Math.min(100, score * 0.95).toFixed(2),
      entryZone: JSON.stringify(entryZone),
      stopZone: JSON.stringify(stopZone),
      targetZone: JSON.stringify(targetZone),
      triggeredAt: Date.now(),
      state: 'NEW',
      regime: state.regime,
      regimeConfidence: state.regimeConfidence,
      userReason,
      gateResults: JSON.stringify(gateResults),
      trendAnalysis: JSON.stringify({ emaAlignment: state.emaAlignment, tfBreakdown: state.tfBreakdown, trendScore: opportunity.trendScore }),
      oiAnalysis: JSON.stringify({ pcrTrend: state.pcrTrend, oiVelocity: state.oiVelocity, oiPattern: state.oiPattern, wallState: { supportWalls: state.supportWalls, resistanceWalls: state.resistanceWalls } }),
      volumeAnalysis: JSON.stringify({ volumeStrength: opportunity.volumeScore, relativeVolume: state.volumeStrength_5m }),
      regimeAnalysis: JSON.stringify({ regime: state.regime, regimeConfidence: state.regimeConfidence }),
      liquidityAnalysis: JSON.stringify({ spread: (parseFloat(tick.ask || 0) - parseFloat(tick.bid || 0)).toFixed(2), liquidityScore: opportunity.liquidityScore })
    };
  }

  mapGateToState(gateNumber) {
    if (gateNumber === 1) return 'NO_TRADE';
    if (gateNumber === 2) return 'WAIT';
    return 'WATCHLIST_SETUP';
  }
}

module.exports = EntryTriggerEngine;
