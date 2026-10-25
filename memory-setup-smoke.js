
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const WebSocket = require('ws');
const twilio = require('twilio');
const { createPlayerMemoryStore } = require('./player-memory');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForHealth(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}/health`,
          res => {
            res.resume();
            if (res.statusCode === 200) resolve();
            else reject(new Error(`Health returned ${res.statusCode}`));
          }
        );
        req.on('error', reject);
        req.setTimeout(1000, () => req.destroy());
      });
      return;
    } catch {
      await pause(200);
    }
  }
  throw new Error('Staging actor did not start');
}

async function main() {
  // Refuse to operate outside our staging environment.
  assert.equal(
    process.env.PLAYER_MEMORY_SCHEMA,
    'last_call_staging'
  );
  assert.equal(process.env.PLAYER_MEMORY_ENABLED, 'true');
  assert.equal(
    new URL(process.env.PUBLIC_WSS_URL).hostname,
    'last-call-memory-test.onrender.com'
  );

  const store = createPlayerMemoryStore({
    enabled: true,
    databaseUrl: process.env.DATABASE_URL,
    hashSecret: process.env.PLAYER_HASH_SECRET,
    ssl: process.env.PLAYER_DB_SSL === 'true',
    schema: 'last_call_staging'
  });

  const phone = '+1999' +
    crypto.randomInt(1000000, 10000000);

  const seedCallSid =
    'CA' + crypto.randomBytes(16).toString('hex');

  const returnCallSid =
    'CA' + crypto.randomBytes(16).toString('hex');

  const port = Number(process.env.PORT || 10000);
  let client;
  let restoreLog = null;
  let seeded = false;

  await store.init();

  try {
    assert.equal(await store.load(phone), null);

    await store.save({
      phone,
      callSid: seedCallSid,
      runKey: store.runKeyFor(seedCallSid, phone),
      nickname: 'Marcus',
      outcome: 'dead',
      snapshot: {
        location: 'dead',
        hasKey: true,
        recentMoves: ['Found the red key']
      }
    });
    seeded = true;

    let found;
    const foundPromise = new Promise(resolve => {
      found = resolve;
    });

    const originalLog = console.log;

    console.log = (...args) => {
      originalLog(...args);

      if (args.some(item =>
        String(item).includes(
          '[MEMORY] Returning player found'
        )
      )) {
        found();
      }
    };

    restoreLog = () => {
      console.log = originalLog;
    };

    // Start the real actor server inside this test.
    require('./server.js');
    await waitForHealth(port);

    // Generate a valid signature with our staging token.
    const signature = twilio.getExpectedTwilioSignature(
      process.env.TWILIO_AUTH_TOKEN,
      process.env.PUBLIC_WSS_URL,
      {}
    );

    // Connect locally; no real telephone call.
    client = new WebSocket(
      `ws://127.0.0.1:${port}/ws`,
      {
        headers: {
          'x-twilio-signature': signature
        }
      }
    );

    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });

    client.on('error', () => {});

    client.send(JSON.stringify({
      type: 'setup',
      sessionId:
        'VX' + crypto.randomBytes(16).toString('hex'),
      callSid: returnCallSid,
      from: phone,
      customParameters: {}
    }));

    await Promise.race([
      foundPromise,
      pause(8000).then(() => {
        throw new Error(
          'Returning-player log not observed'
        );
      })
    ]);

    console.log(
      '[SETUP SMOKE] RETURNING PLAYER RECOGNIZED'
    );

    // TEST: Marcus tells Marrow to forget him.
    console.log('[SETUP SMOKE] FORGET TEST STARTING');

    assert.ok(
      await store.load(phone),
      'Test player should exist before deletion'
    );

    client.send(JSON.stringify({
      type: 'prompt',
      voicePrompt: 'forget me',
      last: true
    }));

    // Wait for the actual speech handler to delete memory.
    let forgotten = false;

    for (let attempt = 0; attempt < 60; attempt++) {
      const record = await store.load(phone);

      if (record === null) {
        forgotten = true;
        break;
      }

      await pause(250);
    }

    assert.equal(
      forgotten,
      true,
      'Spoken forget command did not delete the record'
    );

    console.log(
      '[SETUP SMOKE] SPOKEN FORGET COMMAND PASSED'
    );

  } finally {
    if (client) client.terminate();
    await pause(300);

    // Safety cleanup if the test failed midway.
    if (seeded) {
      await store.forget(phone);
      assert.equal(await store.load(phone), null);

      console.log(
        '[SETUP SMOKE] TEST PLAYER DELETED'
      );
    }

    if (restoreLog) restoreLog();
  }
}

    
main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(
      '[SETUP SMOKE] FAILED:',
      error.message
    );
    process.exit(1);
  });
