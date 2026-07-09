#!/usr/bin/env node
// scripts/add-earnings.js
// Maintain the earnings blackout calendar (design §1.4 gate 2: no new stock
// setups T-2..T+1 around an earnings date). Manual until an NSE
// corporate-calendar fetch exists — ~40 events/yr across 12 names.
//
//   node scripts/add-earnings.js RELIANCE 2026-07-18 "Q1 results"
//   node scripts/add-earnings.js --list          # upcoming events
//   node scripts/add-earnings.js --remove RELIANCE 2026-07-18
//
// Run inside the app container on prod:
//   docker compose exec app node scripts/add-earnings.js ...

require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const args = process.argv.slice(2);
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    if (args[0] === '--list') {
      const r = await client.query(
        `SELECT symbol, event_date::text, note FROM earnings_calendar
          WHERE event_date >= CURRENT_DATE - 3 ORDER BY event_date, symbol`
      );
      if (r.rows.length === 0) console.log('No upcoming earnings events.');
      for (const row of r.rows) console.log(`${row.event_date}  ${row.symbol}  ${row.note || ''}`);
      return;
    }

    if (args[0] === '--remove') {
      const [, symbol, date] = args;
      if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
        console.error('Usage: --remove SYMBOL YYYY-MM-DD'); process.exit(1);
      }
      const r = await client.query(
        'DELETE FROM earnings_calendar WHERE symbol = $1 AND event_date = $2',
        [symbol.toUpperCase(), date]
      );
      console.log(r.rowCount ? `Removed ${symbol} ${date}` : 'No such event.');
      return;
    }

    const [symbol, date, note] = args;
    if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      console.error('Usage: node scripts/add-earnings.js SYMBOL YYYY-MM-DD [note]');
      process.exit(1);
    }
    await client.query(
      `INSERT INTO earnings_calendar (symbol, event_date, note)
       VALUES ($1, $2, $3) ON CONFLICT (symbol, event_date) DO UPDATE SET note = EXCLUDED.note`,
      [symbol.toUpperCase(), date, note || null]
    );
    console.log(`✓ ${symbol.toUpperCase()} earnings ${date} — blackout ${date} -2..+1 days`);
  } finally {
    await client.end();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
