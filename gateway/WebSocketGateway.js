// gateway/WebSocketGateway.js
const WebSocket = require('ws');

class WebSocketGateway {
  constructor(httpServer, eventBus, redisSchema, config) {
    this.wss = new WebSocket.Server({ server: httpServer });
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.clients = new Set();
    this.subscriber = null;
  }

  async initialize() {
    this.subscriber = await this.eventBus.subscribe('notifications', (message) => {
      this.broadcast(JSON.parse(message));
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      console.log('Client connected. Total:', this.clients.size);

      ws.on('close', () => {
        this.clients.delete(ws);
        console.log('Client disconnected. Total:', this.clients.size);
      });

      ws.on('error', (err) => {
        console.error('WebSocket client error:', err.message);
        this.clients.delete(ws);
      });
    });
  }

  broadcast(message) {
    const data = typeof message === 'string' ? message : JSON.stringify(message);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  async startEventStreaming() {
    const consumerGroup = 'cg-dashboard';
    await this.eventBus.createConsumerGroup(consumerGroup, '$');

    while (true) {
      try {
        const messages = await this.eventBus.readGroup(consumerGroup, 'dash-1', 10, 500);
        if (!messages || messages.length === 0) continue;

        for (const stream of messages) {
          for (const message of stream.messages) {
            this.broadcast({
              type: message.message.type,
              instrument: message.message.instrument,
              data: message.message.data ? JSON.parse(message.message.data) : {}
            });
            await this.eventBus.acknowledge(consumerGroup, message.id);
          }
        }
      } catch (err) {
        console.error('WebSocketGateway streaming error:', err.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
}

module.exports = WebSocketGateway;
