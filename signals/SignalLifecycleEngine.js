// signals/SignalLifecycleEngine.js
const { SignalStates } = require('./SignalTypes');

class SignalLifecycleEngine {
  constructor(eventBus, redisSchema, config) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.config = config.signal;
    this.activeSignals = new Map();
    this.monitors = new Map();
    this.consumerGroup = 'cg-signal';
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
    for (const [id, monitor] of this.monitors) {
      clearInterval(monitor);
    }
    this.monitors.clear();
  }

  async processEvents() {
    while (this.running) {
      try {
        const messages = await this.eventBus.readGroup(this.consumerGroup, 'signal-1', 10, 1000);
        if (!messages || messages.length === 0) continue;

        for (const stream of messages) {
          for (const message of stream.messages) {
            await this.handleEvent(message.message);
            await this.eventBus.acknowledge(this.consumerGroup, message.id);
          }
        }
      } catch (err) {
        console.error('SignalLifecycleEngine error:', err.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async handleEvent(event) {
    if (event.type === 'opportunity:trigger') {
      const signal = JSON.parse(event.data || '{}');
      await this.onTrigger(signal);
    }
  }

  async onTrigger(signal) {
    signal.state = SignalStates.ACTIVE;
    await this.eventBus.hset(this.schema.signal(signal.instrument, signal.id), 'state', SignalStates.ACTIVE);
    this.activeSignals.set(signal.id, signal);
    await this.emitStateChange(signal, SignalStates.NEW, SignalStates.ACTIVE);
    this.monitorSignal(signal);
  }

  monitorSignal(signal) {
    const monitorInterval = setInterval(async () => {
      try {
        const tick = await this.eventBus.hgetall(this.schema.tick(signal.instrument));
        const state = await this.eventBus.hgetall(this.schema.marketState(signal.instrument));
        const ltp = parseFloat(tick.ltp || 0);
        const entryZone = JSON.parse(signal.entryZone || '[]');
        const stopZone = JSON.parse(signal.stopZone || '[]');
        const targetZone = JSON.parse(signal.targetZone || '[]');

        if (signal.state === SignalStates.ACTIVE || signal.state === SignalStates.WATCHING) {
          const inEntryZone = ltp >= entryZone[0] && ltp <= entryZone[1];
          if (inEntryZone) {
            await this.transitionState(signal, SignalStates.TRIGGERED);
          } else if (ltp > entryZone[1] * 1.02 || ltp < entryZone[0] * 0.98) {
            await this.transitionState(signal, SignalStates.WATCHING);
          }
        }

        if (signal.state === SignalStates.TRIGGERED || signal.state === SignalStates.ADD) {
          const hitTarget = signal.direction === 'CE' ? ltp >= targetZone[0] : ltp <= targetZone[0];
          const hitSL = signal.direction === 'CE' ? ltp <= stopZone[1] : ltp >= stopZone[1];

          if (hitTarget) {
            await this.transitionState(signal, SignalStates.EXIT, { outcome: 'TARGET_HIT', exitPrice: ltp });
            this.clearMonitor(signal.id);
          } else if (hitSL) {
            await this.transitionState(signal, SignalStates.EXIT, { outcome: 'SL_HIT', exitPrice: ltp });
            this.clearMonitor(signal.id);
          }
        }

        if (signal.state === SignalStates.ACTIVE || signal.state === SignalStates.WATCHING) {
          const invalidated = await this.checkInvalidation(signal, state);
          if (invalidated) {
            await this.transitionState(signal, SignalStates.ABORTED, { reason: invalidated });
            this.clearMonitor(signal.id);
          }
        }

        if (signal.state === SignalStates.TRIGGERED) {
          const additionalConfirmation = await this.checkAdditionalConfirmation(signal, state);
          if (additionalConfirmation) {
            await this.transitionState(signal, SignalStates.ADD);
          }
        }
      } catch (err) {
        console.error(`Signal monitor error for ${signal.id}:`, err.message);
      }
    }, this.config.exitMonitorInterval);

    this.monitors.set(signal.id, monitorInterval);
  }

  clearMonitor(signalId) {
    const monitor = this.monitors.get(signalId);
    if (monitor) {
      clearInterval(monitor);
      this.monitors.delete(signalId);
    }
  }

  async transitionState(signal, newState, metadata = {}) {
    const oldState = signal.state;
    signal.state = newState;
    await this.eventBus.hset(this.schema.signal(signal.instrument, signal.id), { state: newState, ...metadata });
    await this.emitStateChange(signal, oldState, newState, metadata);

    if ([SignalStates.EXIT, SignalStates.ABORTED].includes(newState)) {
      await this.archiveSignal(signal);
      this.activeSignals.delete(signal.id);
    }
  }

  async emitStateChange(signal, from, to, metadata = {}) {
    await this.eventBus.publish('signal:state', signal.instrument, { signalId: signal.id, from, to, ...metadata });
  }

  async checkInvalidation(signal, state) {
    const regime = state.regime || 'CONSOLIDATING';
    const unfavorable = ['EXTREME', 'DEAD'];
    if (unfavorable.includes(regime)) return `Regime changed to ${regime}`;
    const tfBreakdown = JSON.parse(state.tfBreakdown || '[]');
    const alignedCount = tfBreakdown.filter(d => d === signal.direction).length;
    if (alignedCount < 2) return 'Trend alignment lost';
    return null;
  }

  async checkAdditionalConfirmation(signal, state) {
    const volumeStrength = parseFloat(state.volumeStrength_5m || 0);
    const momentumScore = parseFloat(state.momentumScore || 0);
    return volumeStrength > 85 && momentumScore > 80;
  }

  async archiveSignal(signal) {
    await this.eventBus.publish('signal:archive', signal.instrument, signal);
  }

  getActiveSignals() {
    return Array.from(this.activeSignals.values());
  }
}

module.exports = SignalLifecycleEngine;
