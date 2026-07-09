#!/usr/bin/env node
// scripts/probe-chain-limit.js
//
// One-off diagnostic that answers three questions the stock/MCX expansion
// depends on (docs/STOCK_MCX_EXPANSION_DESIGN.md §0):
//
//   1. Is Dhan's option-chain rate limit really per UNIQUE underlying+expiry
//      per 3s (docs), or global 1-per-3s (what the old poller assumed)?
//      -> sets CHAIN_BUDGET_RPS
//   2. Which UnderlyingSeg works for STOCK option chains (NSE_EQ vs NSE_FNO)?
//   3. Do MCX chains (CRUDEOIL / NATURALGAS / NATGASMINI) serve via MCX_COMM
//      with a FUTURES securityId as underlying, including IV + greeks?
//
// ~30 requests over ~2 minutes, all read-only. Run during market hours.
// While the live server is also polling, a probe call can collide with a
// prod poll inside the same 3s unique window — that costs prod at most one
// skipped poll (already handled) and can add a false rate-limit hit to THIS
// report; rerun once if results look mixed.
//
// TOKEN: this script NEVER generates a token (prod's TOTP cycle owns that).
// Provide a live one via --token=..., DHAN_ACCESS_TOKEN, or Redis
// (pta:dhan:token) — on the prod box:  docker compose exec app node scripts/probe-chain-limit.js
//
// Usage: node scripts/probe-chain-limit.js [--token=...] [--client-id=...] [--dry-run] [--skip-mcx]

require('dotenv').config();
const axios = require('axios');
const readline = require('readline');

const REST = 'https://api.dhan.co';
const INDICES = [
  { symbol: 'NIFTY', id: 13 }, { symbol: 'BANKNIFTY', id: 25 },
  { symbol: 'FINNIFTY', id: 27 }, { symbol: 'MIDCPNIFTY', id: 442 },
  { symbol: 'SENSEX', id: 51 }, { symbol: 'BANKEX', id: 69 }
];
// RELIANCE equity on NSE — the canonical Dhan example id. If it drifts, the
// stock-segment test reports failure loudly rather than guessing.
const STOCK_TEST = { symbol: 'RELIANCE', id: 2885 };
const MCX_SYMBOLS = ['CRUDEOIL', 'NATURALGAS', 'NATGASMINI'];

const args = Object.fromEntries(process.argv.slice(2)
  .map((a) => a.replace(/^--/, '').split('='))
  .map(([k, v]) => [k, v ?? true]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { startedAt: new Date().toISOString(), tests: {} };

async function resolveToken() {
  if (args.token) return { token: args.token, source: 'arg' };
  if (process.env.DHAN_ACCESS_TOKEN) return { token: process.env.DHAN_ACCESS_TOKEN, source: '.env/DHAN_ACCESS_TOKEN' };
  if (process.env.REDIS_URL) {
    try {
      const { createClient } = require('redis');
      const client = createClient({ url: process.env.REDIS_URL });
      await client.connect();
      const raw = await client.get(`${process.env.REDIS_PREFIX || 'pta:'}dhan:token`);
      await client.quit();
      if (raw) {
        // TokenManager stores JSON ({"token":"eyJ...",...}), not the bare JWT
        let token = raw;
        try { token = JSON.parse(raw).token || raw; } catch { /* raw JWT */ }
        return { token, source: 'redis' };
      }
    } catch { /* fall through */ }
  }
  return null;
}

function call(token, clientId, endpoint, body) {
  const t0 = Date.now();
  return axios({
    method: 'POST',
    url: `${REST}${endpoint}`,
    headers: {
      'access-token': token, 'client-id': clientId,
      'Content-Type': 'application/json', Accept: 'application/json'
    },
    data: body,
    timeout: 15000,
    validateStatus: () => true // classify every status ourselves
  }).then((res) => ({
    status: res.status,
    ms: Date.now() - t0,
    errorCode: res.data?.errorCode || res.data?.data?.errorCode || null,
    errorMessage: res.data?.errorMessage || null,
    strikes: res.data?.data?.oc ? Object.keys(res.data.data.oc).length : null,
    expiries: Array.isArray(res.data?.data) ? res.data.data.length : null,
    raw: res.status >= 400 ? JSON.stringify(res.data).slice(0, 200) : undefined
  }));
}

const isRateLimited = (r) => r.status === 429 || r.errorCode === 'DH-904' || /rate|limit/i.test(r.errorMessage || '');
const ok = (r) => r.status === 200 && !r.errorCode;

// Streams the detailed scrip master for nearest-expiry MCX futures — same
// pattern (and same failure modes) as DhanProvider.findIndexFutures.
async function findMcxFutures(symbols) {
  const url = 'https://images.dhan.co/api-data/api-scrip-master-detailed.csv';
  const response = await axios.get(url, { responseType: 'stream' });
  const rl = readline.createInterface({ input: response.data, crlfDelay: Infinity });
  let streamError = null;
  response.data.on('error', (err) => { streamError = err; rl.close(); });

  const wanted = new Set(symbols);
  const today = new Date().toISOString().slice(0, 10);
  const best = new Map();
  let cols = null;

  for await (const line of rl) {
    const values = line.split(',');
    if (!cols) {
      cols = {};
      values.forEach((h, i) => { cols[h.trim()] = i; });
      continue;
    }
    const get = (name) => { const i = cols[name]; return i == null ? '' : (values[i] || '').trim(); };
    if (get('INSTRUMENT') !== 'FUTCOM') continue;
    const underlying = get('UNDERLYING_SYMBOL');
    if (!wanted.has(underlying)) continue;
    const expiry = get('SM_EXPIRY_DATE').slice(0, 10);
    if (!expiry || expiry < today) continue;
    const current = best.get(underlying);
    if (!current || expiry < current.expiry) {
      best.set(underlying, { securityId: get('SECURITY_ID'), expiry });
    }
  }
  if (streamError) throw new Error(`scrip master stream failed: ${streamError.message}`);
  return best;
}

async function main() {
  if (args['dry-run']) {
    console.log('DRY RUN — would execute: token sanity (1 req), burst of 12 unique');
    console.log('(index,expiry) chains @ 250ms spacing, duplicate-request floor test');
    console.log('on BANKEX (3 req), RELIANCE segment test (<=4 req), MCX chain test');
    console.log('(<=6 req + scrip-master download). ~30 requests total over ~2 min.');
    return;
  }

  const cred = await resolveToken();
  const clientId = args['client-id'] || process.env.DHAN_CLIENT_ID;
  if (!cred || !clientId) {
    console.error('No token/client-id. Pass --token=... --client-id=... or set env.');
    console.error('NEVER generate a token here — copy the live one from prod Redis.');
    process.exit(1);
  }
  console.log(`Token source: ${cred.source}\n`);
  const T = (endpoint, body) => call(cred.token, clientId, endpoint, body);

  // ---- 0. token sanity -----------------------------------------------------
  const sanity = await T('/v2/optionchain/expirylist', { UnderlyingScrip: 13, UnderlyingSeg: 'IDX_I' });
  report.tests.sanity = sanity;
  if (!ok(sanity)) {
    console.error('Token sanity FAILED:', sanity.status, sanity.raw || sanity.errorMessage);
    console.error('Token is dead or wrong — aborting before any rate-limit test.');
    process.exit(1);
  }
  console.log(`✓ token valid (NIFTY has ${sanity.expiries} expiries)\n`);
  await sleep(3200);

  // ---- 1. burst: 12 unique (underlying, expiry) chains ---------------------
  console.log('Burst test: expiry lists for 6 indices...');
  const expiries = new Map();
  for (const idx of INDICES) {
    const r = await T('/v2/optionchain/expirylist', { UnderlyingScrip: idx.id, UnderlyingSeg: 'IDX_I' });
    if (ok(r)) expiries.set(idx.symbol, r);
    await sleep(300);
  }
  // Re-fetch raw expiry dates (the summary above only kept counts)
  const expiryDates = new Map();
  for (const idx of INDICES) {
    const res = await axios({
      method: 'POST', url: `${REST}/v2/optionchain/expirylist`,
      headers: { 'access-token': cred.token, 'client-id': clientId, 'Content-Type': 'application/json' },
      data: { UnderlyingScrip: idx.id, UnderlyingSeg: 'IDX_I' },
      timeout: 15000, validateStatus: () => true
    });
    const list = res.data?.data || [];
    if (list.length >= 2) expiryDates.set(idx.symbol, [list[0], list[1]]);
    await sleep(300);
  }
  await sleep(3200);

  console.log('Burst test: 12 unique chains @ 250ms spacing (12 in 3s = 4 req/s)...');
  const burst = [];
  const burstStart = Date.now();
  const pending = [];
  for (const idx of INDICES) {
    const dates = expiryDates.get(idx.symbol);
    if (!dates) continue;
    for (const expiry of dates) {
      pending.push(
        T('/v2/optionchain', { UnderlyingScrip: idx.id, UnderlyingSeg: 'IDX_I', Expiry: expiry })
          .then((r) => burst.push({ underlying: idx.symbol, expiry, ...r }))
      );
      await sleep(250);
    }
  }
  await Promise.all(pending);
  const burstOk = burst.filter(ok).length;
  const burstLimited = burst.filter(isRateLimited).length;
  report.tests.burst = { windowMs: Date.now() - burstStart, total: burst.length, ok: burstOk, rateLimited: burstLimited, detail: burst };
  console.log(`  ${burstOk}/${burst.length} succeeded, ${burstLimited} rate-limited in ${report.tests.burst.windowMs}ms\n`);
  await sleep(3200);

  // ---- 2. duplicate-request floor (BANKEX -- least prod-critical index) ----
  console.log('Duplicate test: same BANKEX chain twice 1s apart, then after 3.2s...');
  const bx = expiryDates.get('BANKEX');
  if (bx) {
    const body = { UnderlyingScrip: 69, UnderlyingSeg: 'IDX_I', Expiry: bx[0] };
    const first = await T('/v2/optionchain', body);
    await sleep(1000);
    const dupFast = await T('/v2/optionchain', body);
    await sleep(3200);
    const dupSlow = await T('/v2/optionchain', body);
    report.tests.duplicate = { first, dupFast, dupSlow };
    console.log(`  t0 ${first.status}, +1s ${dupFast.status}${isRateLimited(dupFast) ? ' (rate-limited — per-unique floor confirmed)' : ''}, +4.2s ${dupSlow.status}\n`);
  }
  await sleep(3200);

  // ---- 3. stock underlying segment -----------------------------------------
  console.log(`Stock test: ${STOCK_TEST.symbol} expiry list under NSE_EQ vs NSE_FNO...`);
  report.tests.stock = {};
  for (const seg of ['NSE_EQ', 'NSE_FNO']) {
    const r = await T('/v2/optionchain/expirylist', { UnderlyingScrip: STOCK_TEST.id, UnderlyingSeg: seg });
    report.tests.stock[seg] = r;
    console.log(`  ${seg}: ${r.status} ${ok(r) ? `(${r.expiries} expiries)` : (r.raw || r.errorMessage || '')}`);
    await sleep(3200);
  }
  const workingSeg = ['NSE_EQ', 'NSE_FNO'].find((s) => ok(report.tests.stock[s]) && report.tests.stock[s].expiries > 0);
  if (workingSeg) {
    const res = await axios({
      method: 'POST', url: `${REST}/v2/optionchain/expirylist`,
      headers: { 'access-token': cred.token, 'client-id': clientId, 'Content-Type': 'application/json' },
      data: { UnderlyingScrip: STOCK_TEST.id, UnderlyingSeg: workingSeg },
      timeout: 15000, validateStatus: () => true
    });
    await sleep(3200);
    const expiry = (res.data?.data || [])[0];
    if (expiry) {
      const chain = await T('/v2/optionchain', { UnderlyingScrip: STOCK_TEST.id, UnderlyingSeg: workingSeg, Expiry: expiry });
      report.tests.stock.chain = { segment: workingSeg, expiry, ...chain };
      console.log(`  ${STOCK_TEST.symbol} chain via ${workingSeg}: ${chain.status}, ${chain.strikes} strikes\n`);
    }
  } else {
    console.log('  NEITHER segment worked — RELIANCE id 2885 may be stale; check scrip master.\n');
  }
  await sleep(3200);

  // ---- 4. MCX ---------------------------------------------------------------
  if (!args['skip-mcx']) {
    console.log('MCX test: resolving front-month futures from scrip master (large download)...');
    try {
      const futs = await findMcxFutures(MCX_SYMBOLS);
      report.tests.mcx = {};
      for (const sym of MCX_SYMBOLS) {
        const fut = futs.get(sym);
        if (!fut) {
          report.tests.mcx[sym] = { error: 'no FUTCOM row found' };
          console.log(`  ${sym}: no futures row in scrip master`);
          continue;
        }
        const el = await T('/v2/optionchain/expirylist', { UnderlyingScrip: parseInt(fut.securityId, 10), UnderlyingSeg: 'MCX_COMM' });
        await sleep(3200);
        let chain = null;
        if (ok(el)) {
          const res = await axios({
            method: 'POST', url: `${REST}/v2/optionchain/expirylist`,
            headers: { 'access-token': cred.token, 'client-id': clientId, 'Content-Type': 'application/json' },
            data: { UnderlyingScrip: parseInt(fut.securityId, 10), UnderlyingSeg: 'MCX_COMM' },
            timeout: 15000, validateStatus: () => true
          });
          await sleep(3200);
          const expiry = (res.data?.data || [])[0];
          if (expiry) {
            chain = await T('/v2/optionchain', { UnderlyingScrip: parseInt(fut.securityId, 10), UnderlyingSeg: 'MCX_COMM', Expiry: expiry });
            await sleep(3200);
          }
        }
        report.tests.mcx[sym] = { future: fut, expirylist: el, chain };
        console.log(`  ${sym}: fut ${fut.securityId} (exp ${fut.expiry}) -> expirylist ${el.status}${chain ? `, chain ${chain.status} (${chain.strikes} strikes)` : ''}`);
      }
    } catch (err) {
      report.tests.mcx = { error: err.message };
      console.log(`  MCX resolution failed: ${err.message}`);
    }
  }

  // ---- verdict ---------------------------------------------------------------
  // Rejections on underlyings the LIVE poller hit inside the same 3s window
  // are collisions (prod's request wins the unique slot), not evidence
  // against concurrency — so judge on successes, not on zero rejections.
  // 2026-07-09 run: 9/12 unique chains inside 3.0s; all 3 rejections matched
  // instruments on prod's rotation. Old serial assumption allowed exactly 1.
  const burstResult = report.tests.burst || { ok: 0 };
  const perUniqueHolds = burstResult.ok >= 8;
  const recommended = perUniqueHolds ? 1.5 : 1 / 3.5;
  report.verdict = {
    perUniqueHolds,
    burstOkIn3s: burstResult.ok,
    duplicateFloorSeen: report.tests.duplicate ? isRateLimited(report.tests.duplicate.dupFast) : null,
    recommendedChainBudgetRps: recommended
  };

  console.log('\n================ VERDICT ================');
  console.log(`Per-unique concurrent chains: ${perUniqueHolds ? `SUPPORTED (${burstResult.ok} unique chains in one 3s window; serial would allow 1)` : 'NOT confirmed — keep serial budget'}`);
  console.log(`Recommended CHAIN_BUDGET_RPS=${recommended === 1.5 ? '1.5' : '0.2857'}`);
  if (report.tests.stock) {
    const seg = ['NSE_EQ', 'NSE_FNO'].find((s) => ok(report.tests.stock[s]) && report.tests.stock[s].expiries > 0);
    console.log(`Stock option-chain underlying segment: ${seg || 'UNRESOLVED'}`);
  }

  const fs = require('fs');
  const out = `probe-report-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${out}`);
}

main().catch((err) => { console.error('Probe failed:', err.message); process.exit(1); });
