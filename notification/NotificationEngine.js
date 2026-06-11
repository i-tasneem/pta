// notification/NotificationEngine.js
class NotificationEngine {
  constructor(eventBus, redisSchema, config) {
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.config = config.notification;
    this.recentNotifications = new Map();
    this.consumerGroup = 'cg-notification';
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
        const messages = await this.eventBus.readGroup(this.consumerGroup, 'notif-1', 10, 1000);
        if (!messages || messages.length === 0) continue;

        for (const stream of messages) {
          for (const message of stream.messages) {
            await this.handleEvent(message.message);
            await this.eventBus.acknowledge(this.consumerGroup, message.id);
          }
        }
      } catch (err) {
        console.error('NotificationEngine error:', err.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async handleEvent(event) {
    const priority = this.getPriority(event.type);
    const notification = {
      id: `${event.type}_${event.instrument || ''}_${Date.now()}`,
      type: event.type,
      instrument: event.instrument,
      priority,
      data: event.data ? JSON.parse(event.data) : {},
      timestamp: Date.now()
    };

    if (await this.shouldNotify(notification)) {
      await this.dispatch(notification);
    }
  }

  getPriority(eventType) {
    const map = {
      'opportunity:trigger': 'CRITICAL',
      'signal:state': 'HIGH',
      'wall:break': 'HIGH',
      'opportunity:score': 'LOW',
      'regime:change': 'LOW',
      'gate:failed': 'MEDIUM'
    };
    return map[eventType] || 'LOW';
  }

  async shouldNotify(notification) {
    const key = `${notification.type}:${notification.instrument}:${notification.data?.signalId || ''}`;
    const lastNotified = this.recentNotifications.get(key);
    const now = Date.now();

    if (lastNotified && (now - lastNotified) < this.config.dedupWindow) {
      return false;
    }

    const throttleMs = this.getThrottleMs(notification.priority);
    if (lastNotified && (now - lastNotified) < throttleMs) {
      return false;
    }

    this.recentNotifications.set(key, now);
    return true;
  }

  getThrottleMs(priority) {
    const map = {
      'CRITICAL': this.config.criticalThrottle,
      'HIGH': this.config.highThrottle,
      'MEDIUM': this.config.mediumThrottle,
      'LOW': this.config.lowThrottle
    };
    return map[priority] || 30000;
  }

  async dispatch(notification) {
    await this.eventBus.publishChannel('notifications', notification);
    await this.eventBus.lpush(this.schema.notificationQueue(), JSON.stringify(notification));
    await this.eventBus.ltrim(this.schema.notificationQueue(), 0, 99);
  }

  async getRecentNotifications(count = 20) {
    const items = await this.eventBus.lrange(this.schema.notificationQueue(), 0, count - 1);
    return items.map(item => { try { return JSON.parse(item); } catch { return null; } }).filter(Boolean);
  }
}

module.exports = NotificationEngine;
