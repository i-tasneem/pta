// utils/Auth.js
// Self-contained auth: scrypt password hashing + HMAC-signed session tokens in
// an httpOnly cookie. No external deps. Cookie Secure flag adapts to the
// request protocol (works over http now, hardens automatically under TLS).
const crypto = require('crypto');

class Auth {
  constructor(secret) {
    if (!secret) {
      // Per-boot random secret invalidates sessions on restart — warn so a
      // stable AUTH_SECRET is set in production.
      secret = crypto.randomBytes(32).toString('hex');
      this._ephemeral = true;
    }
    this.secret = secret;
    this.ttlMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    this.cookieName = 'pta_session';
  }

  hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(pw), salt, 64);
    return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
  }

  verifyPassword(pw, stored) {
    if (!stored || typeof stored !== 'string') return false;
    const [scheme, saltHex, hashHex] = stored.split(':');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  signToken(payload) {
    const body = { ...payload, exp: Date.now() + this.ttlMs };
    const data = Buffer.from(JSON.stringify(body)).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(data).digest('base64url');
    return `${data}.${sig}`;
  }

  verifyToken(token) {
    if (!token || typeof token !== 'string' || !token.includes('.')) return null;
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', this.secret).update(data).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const body = JSON.parse(Buffer.from(data, 'base64url').toString());
      if (!body.exp || body.exp < Date.now()) return null;
      return body;
    } catch {
      return null;
    }
  }

  parseCookies(req) {
    const out = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  cookieHeader(value, req) {
    const secure = req && req.secure ? '; Secure' : '';
    const maxAge = Math.floor(this.ttlMs / 1000);
    return `${this.cookieName}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }

  clearCookieHeader() {
    return `${this.cookieName}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
  }

  // Populates req.user (or null) from the session cookie.
  middleware() {
    return (req, res, next) => {
      const token = this.parseCookies(req)[this.cookieName];
      req.user = this.verifyToken(token);
      next();
    };
  }

  requireAuth() {
    return (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'unauthorized' }));
  }

  requireAdmin() {
    return (req, res, next) =>
      req.user && req.user.role === 'ADMIN' ? next() : res.status(403).json({ error: 'forbidden' });
  }
}

module.exports = Auth;
