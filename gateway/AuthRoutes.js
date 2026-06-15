// gateway/AuthRoutes.js
// Auth endpoints. Signup creates a PENDING account (no password); the operator
// issues a password out of band (manage-users.js), which activates it.
const express = require('express');

module.exports = function authRoutes(db, auth) {
  const r = express.Router();

  r.get('/status', (req, res) => {
    res.json({ enabled: !!(db && db.enabled) });
  });

  r.post('/signup', async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'service unavailable' });
    const { username, name, email, phone, risk_profile } = req.body || {};
    if (!username || !name || !email) {
      return res.status(400).json({ error: 'username, name and email are required' });
    }
    const u = String(username).toLowerCase().trim();
    if (!/^[a-z0-9_.]{3,32}$/.test(u)) {
      return res.status(400).json({ error: 'username must be 3-32 chars: letters, digits, _ or .' });
    }
    try {
      await db.query(
        `INSERT INTO users (username, email, name, phone, risk_profile, role, status)
         VALUES ($1, $2, $3, $4, $5, 'FREE', 'PENDING')`,
        [u, String(email).toLowerCase().trim(), String(name).trim(), phone || null, risk_profile || null]
      );
      res.json({ ok: true, message: 'Request received. Your access password will be provided shortly.' });
    } catch (err) {
      if (/unique|duplicate/i.test(err.message)) {
        return res.status(409).json({ error: 'that username or email is already registered' });
      }
      console.error('signup:', err.message);
      res.status(500).json({ error: 'signup failed' });
    }
  });

  r.post('/login', async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'service unavailable' });
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    try {
      const q = await db.query(
        `SELECT id, username, name, role, status, pw_hash FROM users WHERE username = $1`,
        [String(username).toLowerCase().trim()]
      );
      const user = q.rows[0];
      if (!user || user.status !== 'ACTIVE' || !user.pw_hash || !auth.verifyPassword(password, user.pw_hash)) {
        return res.status(401).json({ error: 'invalid credentials, or account not yet activated' });
      }
      const token = auth.signToken({ sub: user.id, username: user.username, role: user.role });
      res.setHeader('Set-Cookie', auth.cookieHeader(token, req));
      res.json({ user: { id: user.id, username: user.username, name: user.name, role: user.role } });
    } catch (err) {
      console.error('login:', err.message);
      res.status(500).json({ error: 'login failed' });
    }
  });

  r.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    res.json({ ok: true });
  });

  r.get('/me', async (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!db || !db.enabled) return res.json({ user: req.user });
    try {
      const q = await db.query(`SELECT id, username, name, role FROM users WHERE id = $1`, [req.user.sub]);
      if (!q.rows[0]) return res.status(401).json({ error: 'unauthorized' });
      res.json({ user: q.rows[0] });
    } catch {
      res.status(500).json({ error: 'lookup failed' });
    }
  });

  return r;
};
