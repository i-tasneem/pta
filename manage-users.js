// Operator CLI to review signups and issue passwords.
//   node manage-users.js list
//   node manage-users.js set-password <username> [password]   (generates if omitted)
//   node manage-users.js create-admin <username> <password>
require('dotenv').config();
const crypto = require('crypto');
const Database = require('./utils/Database');
const Auth = require('./utils/Auth');
const config = require('./config/pta.config');

function genPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = crypto.randomBytes(12);
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

(async () => {
  const [cmd, arg1, arg2] = process.argv.slice(2);
  const db = new Database(config.postgres);
  await db.connect();
  if (!db.enabled) { console.error('DATABASE_URL required'); process.exit(1); }
  const auth = new Auth(process.env.AUTH_SECRET);

  if (cmd === 'list') {
    const q = await db.query(
      `SELECT username, name, email, phone, role, status, created_at
         FROM users ORDER BY created_at DESC`
    );
    console.table(q.rows);
  } else if (cmd === 'set-password') {
    if (!arg1) { console.error('usage: set-password <username> [password]'); process.exit(1); }
    const password = arg2 || genPassword();
    const r = await db.query(
      `UPDATE users SET pw_hash = $1, status = 'ACTIVE' WHERE username = $2 RETURNING username`,
      [auth.hashPassword(password), arg1.toLowerCase()]
    );
    if (r.rows.length === 0) { console.error('no such username:', arg1); process.exit(1); }
    console.log(`\nActivated ${arg1.toLowerCase()}`);
    console.log(`Password: ${password}`);
    console.log('Share this with the user; they log in with their username + this password.\n');
  } else if (cmd === 'create-admin') {
    if (!arg1 || !arg2) { console.error('usage: create-admin <username> <password>'); process.exit(1); }
    await db.query(
      `INSERT INTO users (username, email, name, role, status, pw_hash)
       VALUES ($1, $2, 'Administrator', 'ADMIN', 'ACTIVE', $3)
       ON CONFLICT (username) DO UPDATE SET pw_hash = EXCLUDED.pw_hash, role = 'ADMIN', status = 'ACTIVE'`,
      [arg1.toLowerCase(), `${arg1.toLowerCase()}@pta.local`, auth.hashPassword(arg2)]
    );
    console.log('admin ready:', arg1.toLowerCase());
  } else {
    console.log('commands: list | set-password <username> [password] | create-admin <username> <password>');
  }

  await db.close();
  process.exit(0);
})().catch((err) => { console.error(err.message); process.exit(1); });
