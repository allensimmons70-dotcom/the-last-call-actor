
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlayerMemoryStore } = require('../player-memory');

test('player memory saves, reloads, and forgets progress', async () => {
  assert.ok(process.env.TEST_DATABASE_URL, 'Missing test database URL');

  const store = createPlayerMemoryStore({
    enabled: true,
    databaseUrl: process.env.TEST_DATABASE_URL,
    hashSecret: 'CI-TEST-ONLY-DO-NOT-USE-IN-PRODUCTION-1234567890',
    ssl: false
    schema: 'last_call_ci'
  });

  await store.init();

  const phone = '+15551234567'; // Fictional test number
  const firstCall = 'CA' + 'a'.repeat(32);
  const secondCall = 'CA' + 'b'.repeat(32);

  try {
    assert.equal(await store.load(phone), null);

    assert.equal(await store.save({
      phone,
      callSid: firstCall,
      runKey: store.runKeyFor(firstCall, phone),
      nickname: 'Marcus',
      outcome: 'dead',
      snapshot: {
        location: 'dead',
        hasKey: true,
        recentMoves: ['The Listener caught Marrow']
      }
    }), true);

    const first = await store.load(phone);

    assert.equal(first.nickname, 'Marcus');
    assert.equal(first.lastOutcome, 'dead');
    assert.equal(first.callCount, 1);
    assert.equal(first.lastSnapshot.hasKey, true);
    assert.deepEqual(first.lastSnapshot.recentMoves, [
      'The Listener caught Marrow'
    ]);

    await store.save({
      phone,
      callSid: secondCall,
      runKey: store.runKeyFor(secondCall, phone),
      nickname: null,
      outcome: 'survived',
      snapshot: {
        location: 'escaped',
        recentMoves: ['Marrow escaped']
      }
    });

    const second = await store.load(phone);

    assert.equal(second.nickname, 'Marcus');
    assert.equal(second.lastOutcome, 'survived');
    assert.equal(second.callCount, 2);
    assert.equal(second.lastSnapshot.location, 'escaped');

    assert.equal(await store.forget(phone), true);
    assert.equal(await store.load(phone), null);

  } finally {
    await store.forget(phone);
  }
});
