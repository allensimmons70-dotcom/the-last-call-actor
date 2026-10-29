'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { normalizeUsPhone, hashCheckoutPhone, createReplayEntitlementLookup } = require('./replay-entitlement');
const secret = '0123456789abcdef0123456789abcdef';

test('normalizes caller numbers exactly as sandbox checkout', () => {
  assert.equal(normalizeUsPhone('(816) 555-0123'), '+18165550123');
  assert.equal(normalizeUsPhone('+1 816-555-0123'), '+18165550123');
  assert.equal(normalizeUsPhone('anonymous'), null);
});

test('hash matches checkout HMAC namespace', () => {
  const expected = crypto.createHmac('sha256', secret)
    .update('the-last-call-replay:+18165550123').digest('hex');
  assert.equal(hashCheckoutPhone('8165550123', secret), expected);
});

test('feature flag off is safely disabled', async () => {
  const lookup = createReplayEntitlementLookup({ enabled: false });
  assert.equal(await lookup.hasActivePass('+18165550123'), false);
});

test('queries active entitlement without exposing raw phone', async () => {
  let seen;
  const lookup = createReplayEntitlementLookup({
    enabled: true, hashSecret: secret,
    pool: { query: async (sql, args) => {
      seen = { sql, args };
      return { rows: [{ active: true }] };
    }}
  });
  assert.equal(await lookup.hasActivePass('+18165550123'), true);
  assert.match(seen.sql, /replay_entitlements/);
  assert.equal(seen.args[0], hashCheckoutPhone('+18165550123', secret));
  assert.ok(!JSON.stringify(seen).includes('+18165550123'));
});

test('invalid caller ID never queries database', async () => {
  const lookup = createReplayEntitlementLookup({
    enabled: true, hashSecret: secret,
    pool: { query: () => { throw new Error('should not query'); } }
  });
  assert.equal(await lookup.hasActivePass('anonymous'), false);
});

test('database error fails closed', async () => {
  const lookup = createReplayEntitlementLookup({
    enabled: true, hashSecret: secret,
    pool: { query: async () => { throw Object.assign(new Error('down'), { code: 'CONNECTION_FAILED' }); } }
  });
  assert.equal(await lookup.hasActivePass('+18165550123'), false);
});
