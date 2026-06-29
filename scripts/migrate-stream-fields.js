#!/usr/bin/env node
// scripts/migrate-stream-fields.js
//
// One-time migration for Redis streams written before the EventBus.xadd fix
// (commit "store stream fields under named keys, not numeric").
//
// The old xadd() flattened fields to a [k,v,...] array, so node-redis v4 stored
// them under numeric keys: {0:'open',1:'23385.15',2:'high',...} instead of
// {open:'23385.15',high:...}. This script rewrites every affected stream in
// place, converting numeric-keyed entries back to named fields while preserving
// each entry's original ID and order. Entries already in named form (written
// after the fix shipped) are passed through untouched, so mixed streams are fine.
//
// Streams written via xadd: ohlc:*, oi_history:*, tick:*. The market:events
// stream is written with a proper object (named fields) and has consumer groups;
// per-entry detection skips it. The affected streams have no consumer groups, so
// rebuilding them is safe.
//
// Usage:
//   node scripts/migrate-stream-fields.js                 # dry-run (default)
//   node scripts/migrate-stream-fields.js --apply         # perform the migration
//   REDIS_URL=redis://127.0.0.1:6379 node scripts/migrate-stream-fields.js --apply
//   REDIS_KEY_MATCH='pta:*' node scripts/migrate-stream-fields.js --apply
//
// Idempotent: a second run finds nothing to convert and is a no-op.

const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const MATCH = process.env.REDIS_KEY_MATCH || '*';
const APPLY = process.argv.includes('--apply');
const TMP_SUFFIX = '::__migrating';

// True when every field key of a stream entry is a numeric string ('0','1',...),
// which is the signature of the old flattened-array storage.
function isNumericKeyed(message) {
  const keys = Object.keys(message);
  if (keys.length === 0) return false;
  return keys.every((k) => /^\d+$/.test(k));
}

// {0:'open',1:'23385.15',2:'high',3:'23400',...} -> {open:'23385.15',high:'23400',...}
function toNamed(message) {
  const vals = Object.keys(message)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => message[k]);
  const out = {};
  for (let i = 0; i + 1 < vals.length; i += 2) out[vals[i]] = vals[i + 1];
  return out;
}

async function scanStreamKeys(client) {
  const keys = [];
  for await (const key of client.scanIterator({ MATCH, COUNT: 500 })) {
    if ((await client.type(key)) === 'stream') keys.push(key);
  }
  return keys.sort();
}

async function migrate() {
  const client = createClient({ url: REDIS_URL });
  client.on('error', (e) => console.error('redis error:', e.message));
  await client.connect();

  console.log(`Redis:   ${REDIS_URL}`);
  console.log(`Match:   ${MATCH}`);
  console.log(`Mode:    ${APPLY ? 'APPLY (will rewrite streams)' : 'DRY-RUN (no changes)'}`);
  console.log('');

  const streamKeys = await scanStreamKeys(client);
  let converted = 0;
  let skipped = 0;
  let totalEntriesConverted = 0;

  for (const key of streamKeys) {
    const entries = await client.xRange(key, '-', '+');
    if (entries.length === 0) { skipped++; continue; }

    const numericEntries = entries.filter((e) => isNumericKeyed(e.message)).length;
    if (numericEntries === 0) {
      skipped++;
      console.log(`  skip   ${key}  (${entries.length} entries already named)`);
      continue;
    }

    converted++;
    totalEntriesConverted += numericEntries;
    console.log(`  FIX    ${key}  (${numericEntries}/${entries.length} numeric-keyed)`);

    if (!APPLY) continue;

    const tmp = `${key}${TMP_SUFFIX}`;
    await client.del(tmp); // clean any aborted previous run
    for (const e of entries) {
      const named = isNumericKeyed(e.message) ? toNamed(e.message) : e.message;
      // Preserve the original entry ID and order (entries are ascending).
      await client.xAdd(tmp, e.id, named);
    }
    // RENAME atomically replaces the original (consumer-group-free) stream.
    await client.rename(tmp, key);
  }

  console.log('');
  console.log(`Streams scanned:        ${streamKeys.length}`);
  console.log(`Streams ${APPLY ? 'converted' : 'to convert'}:  ${converted}`);
  console.log(`Streams skipped:        ${skipped}`);
  console.log(`Entries ${APPLY ? 'converted' : 'to convert'}:  ${totalEntriesConverted}`);
  if (!APPLY && converted > 0) {
    console.log('\nDry-run only. Re-run with --apply to perform the migration.');
  }

  await client.disconnect();
}

migrate().catch((e) => { console.error(e); process.exit(1); });
