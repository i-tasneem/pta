// utils/TokenManager.js
const axios = require('axios');
const { TOTP } = require('totp-generator');

class TokenManager {
  constructor(config, redisClient) {
    this.clientId = config.clientId;
    this.pin = config.pin;
    this.totpSecret = config.totpSecret;
    this.redis = redisClient; // pass in from server.js
    this.currentToken = null;
    this.expiryTime = null;
    this.refreshInterval = null;
  }

  async initialize() {
    // Try to reuse cached token first
    if (this.redis) {
      const cached = await this.redis.get('pta:dhan:token');
      if (cached) {
        const { token, expiry } = JSON.parse(cached);
        const expiryDate = new Date(expiry);
        if (expiryDate.getTime() - Date.now() > 5 * 60 * 1000) { // >5min remaining
          this.currentToken = token;
          this.expiryTime = expiryDate;
          console.log(`Reusing cached token. Expires: ${expiryDate.toISOString()}`);
          this._scheduleRefresh();
          return;
        }
      }
    }
    await this.generateToken();
    this._scheduleRefresh();
  }

  _scheduleRefresh() {
    this.refreshInterval = setInterval(() => {
      this.generateToken().catch(err => console.error('Token refresh failed:', err));
    }, 20 * 60 * 60 * 1000);
  }

  async generateToken() {
    const { otp } = TOTP.generate(this.totpSecret);
    const response = await axios.post(
      'https://auth.dhan.co/app/generateAccessToken',
      null,
      { params: { dhanClientId: this.clientId, pin: this.pin, totp: otp } }
    );

    const { accessToken, expiryTime } = response.data;
    if (!accessToken || !expiryTime) {
      throw new Error(`Dhan auth failed: ${JSON.stringify(response.data)}`);
    }
    const parsed = new Date(expiryTime);
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid expiryTime: "${expiryTime}"`);
    }

    this.currentToken = accessToken;
    this.expiryTime = parsed;

    // Cache in Redis
    if (this.redis) {
      await this.redis.set('pta:dhan:token', JSON.stringify({
        token: accessToken,
        expiry: expiryTime
      }), { EX: 23 * 60 * 60 }); // 23h TTL
    }

    console.log(`Token generated. Expires: ${this.expiryTime.toISOString()}`);
    return this.currentToken;
  }
  async getToken() {
  if (!this.isTokenValid()) {
    await this.generateToken();
  }
  return this.currentToken;
}

isTokenValid() {
  return (
    this.currentToken &&
    this.expiryTime &&
    this.expiryTime.getTime() > Date.now() + 5 * 60 * 1000
  );
}

stop() {
  if (this.refreshInterval) {
    clearInterval(this.refreshInterval);
  }
}
}

module.exports = TokenManager;
