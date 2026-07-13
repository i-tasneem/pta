// gateway/WebSocketGateway.js
const WebSocket = require('ws');

class WebSocketGateway {
  constructor(httpServer, eventBus, redisSchema, config, auth = null, authRequired = false) {
    this.httpServer = httpServer;
    this.auth = auth;
    this.authRequired = authRequired;
    this.wss = new WebSocket.Server({ noServer: true });
    this.eventBus = eventBus;
    this.schema = redisSchema;
    this.clients = new Set();
    this.subscriber = null;
    this.running = false;
    this.upgradeHandler = (req, socket, head) => {
      if (this.authRequired) {
        const token = this.auth && this.auth.parseCookies(req)[this.auth.cookieName];
        if (!this.auth || !this.auth.verifyToken(token)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
      });
    };
    this.httpServer.on('upgrade', this.upgradeHandler);
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
    this.running = true;
    const consumerGroup = 'cg-dashboard';
    await this.eventBus.createConsumerGroup(consumerGroup, '$');

    while (this.running) {
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
        if (!this.running) break;
        console.error('WebSocketGateway streaming error:', err.message);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }

  async stop() {
    this.running = false;
    this.httpServer.removeListener('upgrade', this.upgradeHandler);
    for (const client of this.clients) client.close(1001, 'server shutdown');
    await new Promise((resolve) => this.wss.close(() => resolve()));
  }
}

module.exports = WebSocketGateway;
