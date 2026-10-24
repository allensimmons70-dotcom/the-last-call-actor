
'use strict';

// THE LAST CALL — Player Memory v1
// Stores only opted-in progress in PostgreSQL.

const crypto = require('node:crypto');

const OUTCOMES = new Set([
  'survived', 'dead', 'expired', 'interrupted'
]);

function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const phone = value.trim();
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

function extractNickname(speech) {
  if (typeof speech !== 'string') return null;

  const match =
    /(?:^|[.!?]\s*)(?:my name is|call me|you can call me|my friends call me)\s+([a-z][a-z' -]{0,50})/i
      .exec(speech.trim());

  if (!match) return null;

  const candidate = match[1]
    .split(/\s+(?:and|but|because|please|remember|if)\b|[,.!?]/i)[0]
    .replace(/\s+/g, ' ')
    .trim();

  if (
    !candidate ||
    candidate.length > 32 ||
    candidate.split(' ').length > 3
  ) return null;

  return candidate;
}

function memoryCommand(speech) {
  if (typeof speech !== 'string') return null;

  const text = speech.toLowerCase()
    .replace(/[’]/g, "'").trim();

  if (/\b(forget me|delete my (?:memory|progress|saved data)|erase my (?:memory|progress)|remove my saved (?:data|progress))\b/.test(text))
    return 'forget';

  if (/\b(don't|do not|never)\s+(?:remember me|save my (?:progress|data|story))\b/.test(text))
    return 'forget';

  if (/\b(remember me|save my progress|save my story|remember my progress)\b/.test(text))
    return 'remember';

  return null;
}

function storySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object')
    return {};

  return {
    location: String(snapshot.location || '').slice(0, 32),
    hasKey: snapshot.hasKey === true,
    injured: snapshot.injured === true,
    hidden: snapshot.hidden === true,

    clues: Array.isArray(snapshot.clues)
      ? snapshot.clues.filter(x => typeof x === 'string')
          .slice(0, 10).map(x => x.slice(0, 32))
      : [],

    recentMoves: Array.isArray(snapshot.recentMoves)
      ? snapshot.recentMoves
          .filter(x => typeof x === 'string')
          .slice(-5).map(x => x.slice(0, 180))
      : []
  };
}

function createPlayerMemoryStore({
  databaseUrl,
  hashSecret,
  enabled,
  ssl = false
} = {}) {

  if (!enabled) return null;

  if (!databaseUrl || !hashSecret ||
      hashSecret.length < 32) {
    throw new Error(
      'Memory enabled but database or hash secret is missing'
    );
  }

  let pool;
  let initialized = false;

  function hash(kind, input) {
    return crypto.createHmac('sha256', hashSecret)
      .update(`${kind}:${input}`)
      .digest('hex');
  }

  function keyFor(phone) {
    const normalized = normalizePhone(phone);
    return normalized
      ? hash('caller', normalized)
      : null;
  }

  function runKeyFor(callSid, phone) {
    const identifier =
      typeof callSid === 'string' &&
      /^CA[a-f0-9]{32}$/i.test(callSid)
        ? callSid
        : crypto.randomUUID();

    return hash('call', `${phone}:${identifier}`);
  }

  async function init() {
    if (initialized) return;

    const { Pool } = require('pg');

    pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      ...(ssl ? {
        ssl: { rejectUnauthorized: true }
      } : {})
    });

    await pool.query(`
      CREATE TABLE IF NOT EXISTS last_call_players (
        player_key TEXT PRIMARY KEY,
        nickname VARCHAR(32),
        last_outcome TEXT CHECK (
          last_outcome IN (
            'survived','dead','expired','interrupted'
          )
        ),
        last_snapshot JSONB NOT NULL
          DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS last_call_runs (
        run_key TEXT PRIMARY KEY,
        player_key TEXT NOT NULL
          REFERENCES last_call_players(player_key)
          ON DELETE CASCADE,
        outcome TEXT CHECK (
          outcome IN (
            'survived','dead','expired','interrupted'
          )
        ),
        snapshot JSONB NOT NULL
          DEFAULT '{}'::jsonb,
        first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS
        last_call_runs_player_idx
        ON last_call_runs (
          player_key, first_seen DESC
        );
    `);

    initialized = true;
  }

  async function load(phone) {
    if (!initialized)
      throw new Error('Player memory is not initialized');

    const key = keyFor(phone);
    if (!key) return null;

    const result = await pool.query(`
      SELECT
        p.nickname,
        p.last_outcome,
        p.last_snapshot,
        (
          SELECT count(*)::integer
          FROM last_call_runs r
          WHERE r.player_key = p.player_key
        ) AS call_count
      FROM last_call_players p
      WHERE p.player_key = $1
    `, [key]);

    const row = result.rows[0];

    return row ? {
      nickname: row.nickname || null,
      lastOutcome: row.last_outcome || null,
      lastSnapshot: row.last_snapshot || {},
      callCount: row.call_count || 0
    } : null;
  }

  async function save({
    phone, callSid, runKey,
    nickname, outcome, snapshot
  }) {
    if (!initialized)
      throw new Error('Player memory is not initialized');

    const key = keyFor(phone);
    if (!key) return false;

    const cleanName =
      typeof nickname === 'string'
        ? extractNickname(`call me ${nickname}`)
        : null;

    const savedOutcome =
      OUTCOMES.has(outcome) ? outcome : null;

    const savedSnapshot = storySnapshot(snapshot);
    const callKey = runKey || runKeyFor(callSid, phone);

    const db = await pool.connect();

    try {
      await db.query('BEGIN');

      await db.query(`
        INSERT INTO last_call_players (
          player_key, nickname
        )
        VALUES ($1, $2)
        ON CONFLICT (player_key) DO UPDATE
        SET nickname = COALESCE(
          EXCLUDED.nickname,
          last_call_players.nickname
        ),
        updated_at = now()
      `, [key, cleanName]);

      await db.query(`
        INSERT INTO last_call_runs (
          run_key, player_key, outcome, snapshot
        )
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (run_key) DO UPDATE
        SET outcome = EXCLUDED.outcome,
            snapshot = EXCLUDED.snapshot,
            updated_at = now()
      `, [
        callKey,
        key,
        savedOutcome,
        JSON.stringify(savedSnapshot)
      ]);

      if (savedOutcome) {
        await db.query(`
          UPDATE last_call_players
          SET last_outcome = $2,
              last_snapshot = $3::jsonb,
              updated_at = now()
          WHERE player_key = $1
        `, [
          key,
          savedOutcome,
          JSON.stringify(savedSnapshot)
        ]);
      }

      await db.query('COMMIT');
      return true;

    } catch (err) {
      await db.query('ROLLBACK');
      throw err;

    } finally {
      db.release();
    }
  }

  async function forget(phone) {
    if (!initialized)
      throw new Error('Player memory is not initialized');

    const key = keyFor(phone);
    if (!key) return false;

    await pool.query(
      'DELETE FROM last_call_players WHERE player_key = $1',
      [key]
    );

    return true;
  }

  return {
    init, load, save, forget, runKeyFor
  };
}

module.exports = {
  normalizePhone,
  extractNickname,
  memoryCommand,
  storySnapshot,
  createPlayerMemoryStore
};
