#!/usr/bin/env node
// scripts/probe-sustained.js
// Maps Dhan's SUSTAINED option-chain acceptance ceiling — the number that
// actually matters and that burst probes (probe-chain-limit.js) get wrong.
// 2026-07-10 evidence: one 3s burst of 9 uniques passed, yet sustained
// 0.45/s, then 0.30/s, then even half-rate recovery (~0.15/s) drew 805s the
// same afternoon — the limiter appears stateful/punitive after violations.
//
// Staircase: hold each request rate for a full window, count 805s, abort
// the step on the first one and cool off before the next. Run on a WEEKEND
// (markets closed, data is frozen and worthless, rate behavior identical)
// with the app STOPPED (docker compose stop app) so nothing else shares the
// limiter. Total runtime ~1h.
//
//   docker compose stop app
//   docker compose run --rm app node scripts/probe-sustained.js --token=$TOKEN
//   docker compose up -d app
//
// Token: same rules as probe-chain-limit.js — NEVER generated here.

require('dotenv').config();
const axios = require('axios');

const REST = 'https://api.dhan.co';
// Rotate across all six indices so the 3s per-unique rule is never the
// thing being measured.
const IDS = [13, 25, 27, 442, 51, 69];

const STEPS = [
  { perMin: 6, minutes: 8 },
  { perMin: 12, minutes: 10 },
  { perMin: 18, minutes: 10 },
  { perMin: 24, minutes: 10 },
  { perMin: 30, minutes: 10 }
];
const COOL_MS = 5 * 60000;

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.replace(/^--/, '').split('='))
  .map(([k, v]) => [k, v ?? true]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function resolveToken() {
  if (args.token) return args.token;
  if (process.env.DHAN_ACCESS_TOKEN) return process.env.DHAN_ACCESS_TOKEN;
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = require('redis');
      const client = createClient({ url: process.env.REDIS_URL });
      await client.connect();
      const raw = await client.get(`${process.env.REDIS_PREFIX || 'pta:'}dhan:token`);
      await client.quit();
      if (raw) { try { return JSON.parse(raw).token || raw; } catch { return raw; } }
    } catch { /* fall through */ }
  }
  return null;
}

async function main() {
  const token = await resolveToken();
  const clientId = args['client-id'] || process.env.DHAN_CLIENT_ID;
  if (!token || !clientId) {
    console.error('No token/client-id (never generated here — copy the live one).');
    process.exit(1);
  }

  const call = async (id) => {
    const t0 = Date.now();
    const res = await axios({
      method: 'POST',
      url: `${REST}/v2/optionchain/expirylist`,
      headers: { 'access-token': token, 'client-id': clientId, 'Content-Type': 'application/json' },
      data: { UnderlyingScrip: id, UnderlyingSeg: 'IDX_I' },
      timeout: 15000,
      validateStatus: () => true
    });
    const body = JSON.stringify(res.data || {});
    return {
      ok: res.status === 200 && !/805|806/.test(body),
      limited: res.status === 429 || /805|too many/i.test(body),
      status: res.status,
      ms: Date.now() - t0
    };
  };

  // Sanity
  const sanity = await call(13);
  if (!sanity.ok) {
    console.error(`Sanity call failed (${sanity.status}) — fix token/subscription first.`);
    process.exit(1);
  }
  console.log('✓ token + subscription OK; starting staircase\n');
  await sleep(5000);

  const results = [];
  let idx = 0;
  for (const step of STEPS) {
    const gapMs = Math.round(60000 / step.perMin);
    const total = step.perMin * step.minutes;
    console.log(`=== STEP ${step.perMin}/min for ${step.minutes}min (gap ${gapMs}ms, ${total} calls) ===`);
    let ok = 0, limited = 0, other = 0;
    let aborted = false;

    for (let i = 0; i < total; i++) {
      const r = await call(IDS[idx++ % IDS.length]);
      if (r.ok) ok++;
      else if (r.limited) {
        limited++;
        console.log(`  805 at call ${i + 1}/${total} (${Math.round(i * gapMs / 60000)}min in) — aborting step`);
        aborted = true;
        break;
      } else other++;
      await sleep(gapMs);
    }

    results.push({ perMin: step.perMin, ok, limited, other, aborted });
    console.log(`  result: ${ok} ok, ${limited} limited, ${other} other${aborted ? ' (ABORTED)' : ' — CLEAN'}\n`);
    if (aborted) {
      console.log(`  cooling off ${COOL_MS / 60000}min before next step...\n`);
      await sleep(COOL_MS);
    }
  }

  console.log('================ VERDICT ================');
  const lastClean = [...results].reverse().find((r) => !r.aborted && r.limited === 0);
  for (const r of results) {
    console.log(`${String(r.perMin).padStart(3)}/min: ${r.aborted ? 'TRIPPED' : 'clean'} (${r.ok} ok, ${r.limited} limited)`);
  }
  if (lastClean) {
    const budget = (lastClean.perMin / 60 * 0.8).toFixed(2);
    console.log(`\nHighest clean sustained rate: ${lastClean.perMin}/min`);
    console.log(`Recommended CHAIN_BUDGET_RPS=${budget} (80% of measured)`);
  } else {
    console.log('\nNO clean step — the account limiter is severely restricted; contact Dhan support.');
  }

  require('fs').writeFileSync(
    `sustained-probe-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify({ results, at: new Date().toISOString() }, null, 2)
  );
}

main().catch((err) => { console.error('Probe failed:', err.message); process.exit(1); });
