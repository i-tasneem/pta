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
    this.refreshTimer = null;
    // Set by server.js after the provider exists; called with every new/reused
    // token so the provider's REST headers and WS reconnects never go stale.
    this.onToken = null;
  }

  // Dhan's expiryTime is IST wall time WITHOUT a timezone designator (e.g.
  // "2026-07-08T07:41:12.284"; the JWT exp field confirms it's IST). Parsing
  // it with a bare `new Date()` on a UTC box overestimates the token's life
  // by 5.5 hours — the token actually died just before market open every day.
  parseDhanExpiry(s) {
    if (typeof s !== 'string' || !s) return new Date(NaN);
    const hasZone = /Z$|[+-]\d{2}:?\d{2}$/.test(s);
    return new Date(hasZone ? s : `${s}+05:30`);
  }

  async initialize() {
    // Try to reuse cached token first
    if (this.redis) {
      const cached = await this.redis.get('pta:dhan:token');
      if (cached) {
        const { token, expiry } = JSON.parse(cached);
        const expiryDate = this.parseDhanExpiry(expiry);
        if (expiryDate.getTime() - Date.now() > 30 * 60 * 1000) { // >30min remaining
          this.currentToken = token;
          this.expiryTime = expiryDate;
          if (this.onToken) this.onToken(token);
          console.log(`Reusing cached Dhan token. Expires: ${expiryDate.toISOString()}`);
          this._scheduleRefresh();
          return;
        }
      }
    }
    await this.generateToken();
  }

  // Refresh 30 minutes before the token actually dies (not a fixed interval —
  // a fixed 20h timer drifted against Dhan's 24h token life and left multi-hour
  // dead windows right before market open).
  _scheduleRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const msLeft = this.expiryTime ? this.expiryTime.getTime() - Date.now() : 0;
    const delay = Math.max(60 * 1000, msLeft - 30 * 60 * 1000);
    this.refreshTimer = setTimeout(() => {
      this.generateToken().catch(err => {
        console.error('Token refresh failed, retrying in 5min:', err.message);
        this.refreshTimer = setTimeout(() => this.generateToken().catch(e =>
          console.error('Token refresh retry failed:', e.message)), 5 * 60 * 1000);
      });
    }, delay);
    if (this.refreshTimer.unref) this.refreshTimer.unref();
    console.log(`Token refresh scheduled in ${Math.round(delay / 60000)} min`);
  }

  async generateToken(allowWait = true) {
    // Hard generation budget: 3 per rolling hour (the scheduled refresh needs
    // 1/day). On 2026-07-10 a dead Data-API subscription made every fresh
    // token look rejected, and the auth-error path regenerated 24 tokens in
    // ~50 min — the exact TOTP-hammering pattern that once got TOTP disabled
    // on the account. When the budget is gone the problem is NOT the token;
    // refuse loudly instead of hammering Dhan auth.
    if (allowWait) {
      const now = Date.now();
      this.genTimes = (this.genTimes || []).filter((t) => now - t < 60 * 60 * 1000);
      if (this.genTimes.length >= 3) {
        throw new Error('Token generation budget exhausted (3/hr) — auth rejections are not token-related; investigate (subscription? account block?) instead of regenerating');
      }
      this.genTimes.push(now);
    }
    const { otp } = TOTP.generate(this.totpSecret);
    // validateStatus: Dhan reports the one-token-per-2-minutes limit as an
    // error status; with default axios behavior that threw before the wait
    // branch could run, and the process crash-looped through restarts —
    // hammering Dhan auth with TOTP attempts until Dhan disabled TOTP.
    const response = await axios.post(
      'https://auth.dhan.co/app/generateAccessToken',
      null,
      {
        params: { dhanClientId: this.clientId, pin: this.pin, totp: otp },
        validateStatus: () => true
      }
    );

    const body = response.data || {};
    const message = typeof body.message === 'string' ? body.message : '';

    // Dhan allows one token per 2 minutes; wait it out instead of crashing,
    // otherwise a restart loop never escapes the rate limit
    if (allowWait && message.includes('2 minutes')) {
      console.warn('Dhan token rate-limited, waiting 130s before retry...');
      await new Promise(r => setTimeout(r, 130000));
      return this.generateToken(false);
    }

    const { accessToken, expiryTime } = body;
    if (response.status !== 200 || !accessToken || !expiryTime) {
      throw new Error(`Dhan auth failed (HTTP ${response.status}): ${JSON.stringify(body)}`);
    }
    const parsed = this.parseDhanExpiry(expiryTime);
    if (isNaN(parsed.getTime())) {
      throw new Error(`Invalid expiryTime: "${expiryTime}"`);
    }

    this.currentToken = accessToken;
    this.expiryTime = parsed;
    if (this.onToken) this.onToken(accessToken);

    // Cache in Redis until the token's real expiry (minus a safety margin)
    if (this.redis) {
      const ttl = Math.max(60, Math.floor((parsed.getTime() - Date.now()) / 1000) - 300);
      await this.redis.set('pta:dhan:token', JSON.stringify({
        token: accessToken,
        expiry: expiryTime
      }), { EX: ttl });
    }

    console.log(`Token generated. Expires: ${this.expiryTime.toISOString()}`);
    this._scheduleRefresh();
    return this.currentToken;
  }

  async getToken() {
    if (!this.isTokenValid()) {
      await this.generateToken();
    }
    return this.currentToken;
  }

  // Drop the cached token (e.g. after the broker rejects it) and force a fresh one
  async invalidate() {
    this.currentToken = null;
    this.expiryTime = null;
    if (this.redis) {
      await this.redis.del('pta:dhan:token');
    }
    return this.generateToken();
  }

  isTokenValid() {
    return (
      this.currentToken &&
      this.expiryTime &&
      this.expiryTime.getTime() > Date.now() + 5 * 60 * 1000
    );
  }

  stop() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }
}

module.exports = TokenManager;
