// utils/EventBus.js
const { createClient } = require('redis');

class EventBus {
  constructor(redisUrl, keyPrefix = 'pta') {
    this.redisUrl = redisUrl;
    this.keyPrefix = keyPrefix;
    this.client = null;
    this.publisher = null;
  }

  async connect() {
    this.client = createClient({ url: this.redisUrl });
    this.publisher = createClient({ url: this.redisUrl });
    await this.client.connect();
    await this.publisher.connect();
  }

  async disconnect() {
    if (this.client) await this.client.disconnect();
    if (this.publisher) await this.publisher.disconnect();
  }

  // Publish event to stream
  async publish(eventType, instrument, data) {
    const streamKey = `${this.keyPrefix}:market:events`;
    return await this.client.xAdd(streamKey, '*', {
      type: eventType,
      instrument: instrument || '',
      data: JSON.stringify(data),
      timestamp: Date.now().toString()
    });
  }

  // Create consumer group
  async createConsumerGroup(groupName, startId = '$') {
    const streamKey = `${this.keyPrefix}:market:events`;
    try {
      await this.client.xGroupCreate(streamKey, groupName, startId, { MKSTREAM: true });
    } catch (err) {
      if (!err.message.includes('already exists')) throw err;
    }
  }

  // Read from consumer group
  async readGroup(groupName, consumerName, count = 1, blockMs = 1000) {
    const streamKey = `${this.keyPrefix}:market:events`;
    const result = await this.client.xReadGroup(
      groupName,
      consumerName,
      [{ key: streamKey, id: '>' }],
      { COUNT: count, BLOCK: blockMs }
    );
    return result;
  }

  // Acknowledge message
  async acknowledge(groupName, messageId) {
    const streamKey = `${this.keyPrefix}:market:events`;
    await this.client.xAck(streamKey, groupName, messageId);
  }

  // Pub/Sub for real-time notifications
  async subscribe(channel, callback) {
    const subscriber = createClient({ url: this.redisUrl });
    await subscriber.connect();
    await subscriber.subscribe(`${this.keyPrefix}:${channel}`, callback);
    return subscriber;
  }

  async publishChannel(channel, message) {
    await this.publisher.publish(`${this.keyPrefix}:${channel}`, JSON.stringify(message));
  }

  // Redis accepts only strings; numbers/booleans crash the encoder,
  // undefined/null corrupt the field list
  _stringifyFields(fields) {
    const flat = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      flat.push(k, String(v));
    }
    return flat;
  }

  // Hash operations
  async hset(key, fields) {
    const flatFields = typeof fields === 'object' && !Array.isArray(fields)
      ? this._stringifyFields(fields)
      : fields.map(String);
    if (flatFields.length === 0) return 0;
    return await this.client.hSet(key, flatFields);
  }

  async hgetall(key) {
    return await this.client.hGetAll(key);
  }

  async hget(key, field) {
    return await this.client.hGet(key, field);
  }

  // Stream operations
  async xadd(key, id, fields) {
    return await this.client.xAdd(key, id, this._stringifyFields(fields));
  }

  async xrange(key, start, end, count) {
    const opts = count ? { COUNT: count } : {};
    return await this.client.xRange(key, start, end, opts);
  }

  async xtrim(key, strategy, threshold) {
    return await this.client.xTrim(key, strategy, threshold);
  }

  // Sorted set operations
  async zadd(key, score, member) {
    return await this.client.zAdd(key, { score, value: member });
  }

  async zrevrange(key, start, stop, withScores = false) {
    const opts = withScores ? { WITH_SCORES: true } : {};
    return await this.client.zRange(key, start, stop, { REV: true, ...opts });
  }

  async zrevrank(key, member) {
    return await this.client.zRank(key, member, { REV: true });
  }

  async zrem(key, member) {
    return await this.client.zRem(key, member);
  }

  async zremrangebyrank(key, start, stop) {
    return await this.client.zRemRangeByRank(key, start, stop);
  }

  // List operations
  async lpush(key, value) {
    return await this.client.lPush(key, value);
  }

  async ltrim(key, start, stop) {
    return await this.client.lTrim(key, start, stop);
  }

  async lrange(key, start, stop) {
    return await this.client.lRange(key, start, stop);
  }

  // TTL
  async expire(key, seconds) {
    return await this.client.expire(key, seconds);
  }

  // General
  async del(key) {
    return await this.client.del(key);
  }

  async ping() {
    return await this.client.ping();
  }
}

module.exports = EventBus;
