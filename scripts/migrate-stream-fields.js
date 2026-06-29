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
// Streams written via xadd are the small, bounded ones: ohlc:* (MAXLEN 500) and
// oi_history:* (MAXLEN 1000). The market:events stream is large and UNBOUNDED but
// is written with a proper object (named fields) and has consumer groups, so it is
// detected as already-named and skipped. (tick:* is a hash, not a stream.)
//
// Memory-safe at production scale: the migrate/skip decision reads only the FIRST
// entry of each stream (COUNT 1), so a huge named stream like market:events is
// never loaded into memory. Streams that DO need converting are read and rewritten
// in bounded batches.
//
// Usage:
//   node scripts/migrate-stream-fields.js                 # dry-run (default)
//   node scripts/migrate-stream-fields.js --apply         # perform the migration
//   REDIS_URL=redis://redis:6379 node scripts/migrate-stream-fields.js --apply
//   REDIS_KEY_MATCH='pta::ohlc:*' node scripts/migrate-stream-fields.js --apply
//
// Idempotent: a second run finds nothing to convert and is a no-op.

const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const MATCH = process.env.REDIS_KEY_MATCH || '*';
const APPLY = process.argv.includes('--apply');
const BATCH = Number(process.env.MIGRATE_BATCH) || 1000;
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

// Read only the oldest entry to decide shape, without loading the whole stream.
async function firstEntryShape(client, key) {
  const first = await client.xRange(key, '-', '+', { COUNT: 1 });
  if (first.length === 0) return 'empty';
  return isNumericKeyed(first[0].message) ? 'numeric' : 'named';
}

// Rewrite a numeric-keyed stream into a temp stream in bounded batches, then
// RENAME over the original. Original IDs and order are preserved; entries already
// in named form pass through unchanged.
async function rewriteStream(client, key) {
  const tmp = `${key}${TMP_SUFFIX}`;
  await client.del(tmp); // clean any aborted previous run
  let lastId = null;
  let count = 0;
  while (true) {
    const start = lastId ? `(${lastId}` : '-'; // exclusive of the last id seen
    const batch = await client.xRange(key, start, '+', { COUNT: BATCH });
    if (batch.length === 0) break;
    for (const e of batch) {
      const named = isNumericKeyed(e.message) ? toNamed(e.message) : e.message;
      await client.xAdd(tmp, e.id, named);
      count++;
    }
    lastId = batch[batch.length - 1].id;
    if (batch.length < BATCH) break;
  }
  await client.rename(tmp, key);
  return count;
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
  let totalEntries = 0;

  for (const key of streamKeys) {
    const shape = await firstEntryShape(client, key);
    if (shape !== 'numeric') {
      skipped++;
      const len = await client.xLen(key);
      console.log(`  skip   ${key}  (${len} entries, ${shape})`);
      continue;
    }

    const len = await client.xLen(key);
    console.log(`  FIX    ${key}  (${len} entries, numeric-keyed)`);
    converted++;
    if (!APPLY) { totalEntries += len; continue; }
    totalEntries += await rewriteStream(client, key);
  }

  console.log('');
  console.log(`Streams scanned:        ${streamKeys.length}`);
  console.log(`Streams ${APPLY ? 'converted' : 'to convert'}:  ${converted}`);
  console.log(`Streams skipped:        ${skipped}`);
  console.log(`Entries ${APPLY ? 'converted' : 'to convert'}:  ${totalEntries}`);
  if (!APPLY && converted > 0) {
    console.log('\nDry-run only. Re-run with --apply to perform the migration.');
  }

  await client.disconnect();
}

migrate().catch((e) => { console.error(e); process.exit(1); });
