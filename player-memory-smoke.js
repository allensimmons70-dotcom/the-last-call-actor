
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createPlayerMemoryStore } = require('./player-memory');

async function run() {
  // Never run this test against production tables.
  if (process.env.PLAYER_MEMORY_SCHEMA !== 'last_call_staging') {
    throw new Error('Smoke test requires staging schema');
  }

  if (process.env.PLAYER_MEMORY_ENABLED !== 'true') {
    throw new Error('Memory must be enabled in staging');
  }

  const store = createPlayerMemoryStore({
    enabled: true,
    databaseUrl: process.env.DATABASE_URL,
    hashSecret: process.env.PLAYER_HASH_SECRET,
    ssl: process.env.PLAYER_DB_SSL === 'true',
    schema: process.env.PLAYER_MEMORY_SCHEMA
  });

  await store.init();

  // Fictional identifier. No telephone call is made.
  const phone = '+999' + crypto.randomInt(100000000, 1000000000);
  const callSid = 'CA' + crypto.randomBytes(16).toString('hex');

  try {
    assert.equal(await store.load(phone), null);

    await store.save({
      phone,
      callSid,
      runKey: store.runKeyFor(callSid, phone),
      nickname: 'Marcus',
      outcome: 'dead',
      snapshot: {
        location: 'dead',
        hasKey: true,
        recentMoves: [
          'Found the red key',
          'The Listener caught Marrow'
        ]
      }
    });

    const saved = await store.load(phone);

    assert.equal(saved.nickname, 'Marcus');
    assert.equal(saved.lastOutcome, 'dead');
    assert.equal(saved.callCount, 1);
    assert.equal(saved.lastSnapshot.hasKey, true);
    assert.equal(
      saved.lastSnapshot.recentMoves[0],
      'Found the red key'
    );

    console.log('[MEMORY SMOKE] SAVE AND RELOAD PASSED');

  } finally {
    await store.forget(phone);
    assert.equal(await store.load(phone), null);
    console.log('[MEMORY SMOKE] DELETE PASSED');
  }
}

run()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('[MEMORY SMOKE] FAILED:', error.message);
    process.exit(1);
  });
