// CLI: node backtest.js --symbol NIFTY --from 2026-06-16 --to 2026-06-21
require('dotenv').config();
const Database = require('./utils/Database');
const Backtester = require('./backtest/Backtester');
const config = require('./config/pta.config');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.symbol || !args.from || !args.to) {
    console.error('Usage: node backtest.js --symbol NIFTY --from YYYY-MM-DD --to YYYY-MM-DD');
    process.exit(1);
  }

  const db = new Database(config.postgres);
  await db.connect();
  if (!db.enabled) {
    console.error('DATABASE_URL is required for backtesting');
    process.exit(1);
  }

  const bt = new Backtester(db);
  const res = await bt.runFromDb(args.symbol, args.from, args.to, { strategy: args.strategy || 'ALL', lifecycle: {} });

  console.log(`\nBacktest ${args.symbol}  ${args.from} -> ${args.to}`);
  console.log(`snapshots replayed: ${res.snapshots}`);
  console.log(`trades: ${res.trades.length}`);
  console.log(JSON.stringify(res.metrics, null, 2));

  await db.close();
  process.exit(0);
})().catch((err) => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
