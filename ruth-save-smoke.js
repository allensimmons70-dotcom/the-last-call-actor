
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { createPlayerMemoryStore } = require('./player-memory');
const ruthPending = require('./ruth-pending');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const callSid = () => 'CA' + crypto.randomBytes(16).toString('hex');
const phone = () => '+1999' + crypto.randomInt(1000000, 10000000);

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/health`,
          res => {
            res.resume();
            res.statusCode === 200
              ? resolve()
              : reject(new Error('Health check failed'));
          }
        );
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy());
      });
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error('Actor did not start');
}

async function main() {
  // Strictly staging-only.
  assert.equal(process.env.PLAYER_MEMORY_SCHEMA, 'last_call_staging');
  assert.equal(process.env.PLAYER_MEMORY_ENABLED, 'true');
  assert.equal(
    new URL(process.env.PUBLIC_WSS_URL).hostname,
    'last-call-memory-test.onrender.com'
  );
  assert.ok((process.env.RUTH_MEMORY_TOKEN || '').length >= 32);
  assert.ok((process.env.PLAYER_HASH_SECRET || '').length >= 32);

  const store = createPlayerMemoryStore({
    enabled: true,
    databaseUrl: process.env.DATABASE_URL,
    hashSecret: process.env.PLAYER_HASH_SECRET,
    ssl: process.env.PLAYER_DB_SSL === 'true',
    schema: 'last_call_staging'
  });

  const first = { phone: phone(), callSid: callSid() };
  const second = { phone: phone(), callSid: callSid() };
  const secret = process.env.PLAYER_HASH_SECRET;
  const port = Number(process.env.PORT || 10000);

  const requestSave = async (caller, outcome, token) => {
    const response = await fetch(
      `http://127.0.0.1:${port}/ruth/memory/save`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          callSid: caller.callSid,
          from: caller.phone,
          outcome
        }),
        signal: AbortSignal.timeout(5000)
      }
    );

    return {
      status: response.status,
      body: await response.json()
    };
  };

  await store.init();

  try {
    assert.equal(await store.load(first.phone), null);
    assert.equal(await store.load(second.phone), null);

    // Start the real HTTP server in this process.
    require('./server.js');
    await waitForHealth(port);

    const staged = ruthPending.stage({
      callSid: first.callSid,
      phone: first.phone,
      secret,
      runKey: store.runKeyFor(first.callSid, first.phone),
      nickname: 'Marcus',
      outcome: 'survived',
      snapshot: {
        location: 'outside',
        hasKey: true,
        recentMoves: ['Escaped the basement']
      }
    });

    assert.equal(staged, true);
    assert.equal(await store.load(first.phone), null);

    // Invalid token must fail.
    const unauthorized = await requestSave(
      first, 'survived', 'wrong-test-token'
    );
    assert.equal(unauthorized.status, 401);
    assert.equal(await store.load(first.phone), null);
    console.log('[RUTH HTTP] UNAUTHORIZED REQUEST REJECTED');

    // Incorrect story outcome must fail.
    const wrongOutcome = await requestSave(
      first, 'dead', process.env.RUTH_MEMORY_TOKEN
    );
    assert.equal(wrongOutcome.status, 409);
    assert.equal(await store.load(first.phone), null);
    console.log('[RUTH HTTP] MISMATCHED OUTCOME REJECTED');

    // Authorized save must work.
    const saved = await requestSave(
      first, 'survived', process.env.RUTH_MEMORY_TOKEN
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.saved, true);

    const record = await store.load(first.phone);
    assert.equal(record.nickname, 'Marcus');
    assert.equal(record.lastOutcome, 'survived');
    assert.equal(record.lastSnapshot.hasKey, true);
    console.log('[RUTH HTTP] PRESS 1 SAVED VERIFIED');

    // Prevent replay of the same completed story.
    const duplicate = await requestSave(
      first, 'survived', process.env.RUTH_MEMORY_TOKEN
    );
    assert.equal(duplicate.status, 409);
    console.log('[RUTH HTTP] DUPLICATE REQUEST REJECTED');

    // Decline: discard temporary progress without saving.
    ruthPending.stage({
      callSid: second.callSid,
      phone: second.phone,
      secret,
      runKey: store.runKeyFor(second.callSid, second.phone),
      nickname: 'Declined',
      outcome: 'dead',
      snapshot: { location: 'dead' }
    });

    ruthPending.discard(
      second.callSid, second.phone, secret
    );

    assert.equal(await store.load(second.phone), null);
    console.log('[RUTH HTTP] DECLINED CALL NOT SAVED');

  } finally {
    ruthPending.discard(first.callSid, first.phone, secret);
    ruthPending.discard(second.callSid, second.phone, secret);

    await store.forget(first.phone);
    await store.forget(second.phone);

    assert.equal(await store.load(first.phone), null);
    assert.equal(await store.load(second.phone), null);
    console.log('[RUTH HTTP] TEST RECORDS CLEANED UP');
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('[RUTH HTTP] FAILED:', error.message);
    process.exit(1);
  });
