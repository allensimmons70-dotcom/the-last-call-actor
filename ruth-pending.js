
'use strict';

const crypto = require('node:crypto');

const pending = new Map();
const TTL_MS = 3 * 60 * 1000;

function keyFor(callSid, phone, secret) {
  if (!/^CA[a-f0-9]{32}$/i.test(String(callSid))) return null;
  if (!/^\+[1-9]\d{7,14}$/.test(String(phone))) return null;
  if (typeof secret !== 'string' || secret.length < 32) return null;

  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify([callSid, phone]))
    .digest('hex');
}

function discard(callSid, phone, secret) {
  const key = keyFor(callSid, phone, secret);
  if (!key) return false;

  const record = pending.get(key);
  if (!record) return false;

  clearTimeout(record.timer);
  pending.delete(key);
  return true;
}

function stage({
  callSid, phone, secret, runKey,
  nickname, outcome, snapshot
}) {
  const key = keyFor(callSid, phone, secret);

  if (!key || !runKey) return false;
  if (!['survived', 'dead', 'expired'].includes(outcome)) {
    return false;
  }

  discard(callSid, phone, secret);

  const snapshotJson = JSON.stringify(snapshot || {});
  if (Buffer.byteLength(snapshotJson) > 64000) return false;

  const timer = setTimeout(() => {
    pending.delete(key);
  }, TTL_MS);

  timer.unref?.();

  pending.set(key, {
    runKey,
    nickname: nickname || null,
    outcome,
    snapshot: JSON.parse(snapshotJson),
    expiresAt: Date.now() + TTL_MS,
    timer
  });

  return true;
}

function read(callSid, phone, secret) {
  const key = keyFor(callSid, phone, secret);
  if (!key) return null;

  const record = pending.get(key);
  if (!record) return null;

  if (Date.now() >= record.expiresAt) {
    discard(callSid, phone, secret);
    return null;
  }

  return record;
}

module.exports = { stage, read, discard };
