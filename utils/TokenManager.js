// utils/TokenManager.js
const axios = require('axios');
const { TOTP } = require('totp-generator'); // npm install totp-generator

class TokenManager {
  constructor(config) {
    this.clientId = config.clientId;
    this.pin = config.pin;
    this.totpSecret = config.totpSecret;
    this.currentToken = null;
    this.expiryTime = null;
    this.refreshInterval = null;
  }

  async initialize() {
    await this.generateToken();
    // Refresh every 20 hours (before 24h expiry)
    this.refreshInterval = setInterval(() => {
      this.generateToken().catch(err => console.error('Token refresh failed:', err));
    }, 20 * 60 * 60 * 1000);
  }

  async generateToken() {
    try {
      // Generate TOTP code from secret
      const { otp } = TOTP.generate(this.totpSecret);
      
      const response = await axios.post(
        `https://auth.dhan.co/app/generateAccessToken`,
        null,
        {
          params: {
            dhanClientId: this.clientId,
            pin: this.pin,
            totp: otp
          }
        }
      );

      this.currentToken = response.data.accessToken;
      this.expiryTime = new Date(response.data.expiryTime);

      // Update environment and provider
      process.env.DHAN_ACCESS_TOKEN = this.currentToken;
      
      console.log(`✓ Token generated. Expires: ${this.expiryTime.toISOString()}`);
      
      return this.currentToken;
    } catch (err) {
      console.error('Token generation failed:', err.response?.data || err.message);
      throw err;
    }
  }

  getToken() {
    if (!this.currentToken || Date.now() >= this.expiryTime.getTime()) {
      throw new Error('Token expired or not generated');
    }
    return this.currentToken;
  }

  isTokenValid() {
    return this.currentToken && Date.now() < this.expiryTime.getTime() - 300000; // 5 min buffer
  }

  stop() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
  }
}

module.exports = TokenManager;
