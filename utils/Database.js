// utils/Database.js
// Postgres = system of record. Disabled gracefully when DATABASE_URL is
// absent (mock/local runs) so the engine still boots without a database.
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

class Database {
  constructor(config = {}) {
    this.url = config.url || process.env.DATABASE_URL || '';
    this.enabled = !!this.url;
    this.pool = null;
  }

  async connect() {
    if (!this.enabled) {
      console.warn('⚠ DATABASE_URL not set — Postgres disabled (no durable history)');
      return;
    }
    this.pool = new Pool({
      connectionString: this.url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
    this.pool.on('error', (err) => console.error('Postgres pool error:', err.message));

    await this.pool.query('SELECT 1');
    await this.migrate();
    console.log('✓ Postgres connected');
  }

  // Idempotent schema apply on boot (all statements are CREATE IF NOT EXISTS)
  async migrate() {
    const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
    if (!fs.existsSync(schemaPath)) {
      console.warn('⚠ db/schema.sql not found, skipping migration');
      return;
    }
    const sql = fs.readFileSync(schemaPath, 'utf8');
    await this.pool.query(sql);
    console.log('✓ Postgres schema applied');
  }

  async query(text, params) {
    return this.pool.query(text, params);
  }

  // Run fn inside a transaction; rolls back on throw
  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

module.exports = Database;
