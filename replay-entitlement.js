'use strict';

// Read-only sandbox Replay Pass lookup. No purchases, phone callbacks, or writes.
// Requires the *checkout* PLAYER_HASH_SECRET, not the actor memory hash secret.
const crypto = require('node:crypto');

function normalizeUsPhone(value) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (!/^\d{10}$/.test(ten) || !/^[2-9]\d\d[2-9]\d{6}$/.test(ten)) return null;
  return `+1${ten}`;
}

function hashCheckoutPhone(phone, hashSecret) {
  const normalized = normalizeUsPhone(phone);
  if (!normalized) return null;
  return crypto.createHmac('sha256', hashSecret)
    .update(`the-last-call-replay:${normalized}`).digest('hex');
}

function createReplayEntitlementLookup({ enabled = false, databaseUrl, hashSecret, ssl = false, pool: providedPool } = {}) {
  if (!enabled) return { enabled: false, hasActivePass: async () => false };
  if (typeof hashSecret !== 'string' || hashSecret.length < 32) {
    throw new Error('REPLAY_HASH_SECRET must match the checkout PLAYER_HASH_SECRET (32+ characters)');
  }
  if (!providedPool && (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl))) {
    throw new Error('REPLAY_DATABASE_URL must be a PostgreSQL connection URL');
  }

  // This connection must use a read-only PostgreSQL role when deployed.
  const pool = providedPool || new (require('pg').Pool)({
    connectionString: databaseUrl,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    max: 2,
    connectionTimeoutMillis: 2500,
    query_timeout: 2500,
    statement_timeout: 2000,
    idleTimeoutMillis: 10000,
  });

  async function hasActivePass(callerFrom) {
    const phoneHash = hashCheckoutPhone(callerFrom, hashSecret);
    if (!phoneHash) return false; // anonymous/invalid caller ID: do not grant paid entitlement
    try {
      const result = await pool.query(
        `SELECT EXISTS (
           SELECT 1 FROM "last_call_checkout_test"."replay_entitlements"
           WHERE phone_hash = $1 AND active = true
         ) AS active`, [phoneHash]
      );
      return result.rows?.[0]?.active === true;
    } catch (err) {
      // Fail closed, leave the normal story available, never log phone or DB credentials.
      console.warn('[REPLAY] Sandbox entitlement lookup unavailable:', err.code || 'database-error');
      return false;
    }
  }
  return { enabled: true, hasActivePass };
}

module.exports = { normalizeUsPhone, hashCheckoutPhone, createReplayEntitlementLookup };
