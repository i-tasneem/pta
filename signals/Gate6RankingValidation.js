// signals/Gate6RankingValidation.js
const DecisionGate = require('./DecisionGate');

class Gate6RankingValidation extends DecisionGate {
  constructor(config) {
    super('Gate6_RankingValidation', 6);
    this.config = config;
  }

  async evaluate(context) {
    const { opportunity, instrument, eventBus, schema } = context;
    const score = parseFloat(opportunity.score || 0);

    // Minimum score
    if (score < this.config.minScore) {
      return this.createFailResult(`Opportunity score ${score.toFixed(1)} below threshold ${this.config.minScore}`);
    }

    // Top 10 check — use the stored id, never reconstruct it
    const opportunityId = opportunity.opportunityId || `${instrument}|${opportunity.direction}`;
    const rank = await eventBus.zrevrank(schema.leaderboard(), opportunityId);
    if (rank === null || rank === undefined || rank > this.config.maxRank) {
      return this.createFailResult(`Opportunity not in top ${this.config.maxRank} (rank: ${rank !== null ? rank + 1 : 'N/A'})`);
    }

    // No conflicting active signal
    const activeSignal = await eventBus.hgetall(schema.activeSignal(instrument));
    if (activeSignal && Object.keys(activeSignal).length > 0 && activeSignal.direction !== opportunity.direction) {
      return this.createFailResult(`Conflicting active signal exists: ${activeSignal.direction}`);
    }

    return this.createPassResult();
  }
}

module.exports = Gate6RankingValidation;
