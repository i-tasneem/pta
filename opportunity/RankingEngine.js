// opportunity/RankingEngine.js
class RankingEngine {
  constructor(eventBus, redisSchema, config) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.config = config.ranking;
    this.consumerGroup = 'cg-ranking';
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
        const messages = await this.eventBus.readGroup(this.consumerGroup, 'ranking-1', 10, 1000);
        if (!messages || messages.length === 0) continue;

        for (const stream of messages) {
          for (const message of stream.messages) {
            await this.handleEvent(message.message);
            await this.eventBus.acknowledge(this.consumerGroup, message.id);
          }
        }
      } catch (err) {
        console.error('RankingEngine error:', err.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async handleEvent(event) {
    if (event.type === 'opportunity:score') {
      const data = JSON.parse(event.data || '{}');
      await this.updateRanking(data);
    }
  }

  async updateRanking(data) {
    const { instrument, score, direction, opportunityId } = data;
    if (!opportunityId) return;

    if (score < 50) {
      await this.eventBus.zrem(this.schema.leaderboard(), opportunityId);
      return;
    }

    await this.eventBus.zadd(this.schema.leaderboard(), score, opportunityId);
    await this.eventBus.zremrangebyrank(this.schema.leaderboard(), 0, -51);

    // Check if top 10 changed
    const top10 = await this.eventBus.zrevrange(this.schema.leaderboard(), 0, 9, true);

    await this.eventBus.publish('ranking:update', '', {
      top10: top10.map((item, i) => ({
        rank: i + 1,
        opportunityId: i % 2 === 0 ? item : '',
        score: i % 2 === 1 ? parseFloat(item) : 0
      })).filter((_, i) => i % 2 === 0)
    });
  }

  async getTopOpportunities(n = 10) {
    const topN = await this.eventBus.zrevrange(this.schema.leaderboard(), 0, n - 1, true);
    const opportunities = [];

    for (let i = 0; i < topN.length; i += 2) {
      const opportunityId = topN[i];
      const score = parseFloat(topN[i + 1]);
      const parts = opportunityId.split('|');
      const instrument = parts[0];

      const opp = await this.eventBus.hgetall(this.schema.opportunity(instrument));
      if (opp && Object.keys(opp).length > 0) {
        opportunities.push({
          ...opp,
          score,
          rank: i / 2 + 1,
          opportunityId
        });
      }
    }

    return opportunities;
  }
}

module.exports = RankingEngine;
