# The Last Call — Sandbox Replay recognition (test branch only)

## Scope

This patch adds **read-only recognition** of an active sandbox Replay Pass in Marrow's opening line. It does NOT change Ruth's earlier Twilio Studio greeting, enforce a payment gate, enable callbacks, make live charges, or verify ownership of the number. The main branch and active call flow must remain unchanged until tested.

## Setup: separate test Render service only

- Deploy from `feature/replay-pass-recognition-test`, not `main`.
- Set `REPLAY_LOOKUP_ENABLED=true` only in a **separate staging/test voice service**.
- Set `REPLAY_DATABASE_URL` to the private/internal Postgres URL of the DB used by `the-last-call-checkout-test` (not to a public webhook URL).
- Set `REPLAY_HASH_SECRET` to **exactly the same secret value as checkout's `PLAYER_HASH_SECRET`**. This hash key is separate from any player-memory hashing key. Never paste either secret into GitHub/chat.
- Set `REPLAY_DB_SSL=false` only for Render's private internal PostgreSQL connection, as appropriate for the existing service config.
- Prefer a Postgres role with SELECT-only access to `last_call_checkout_test.replay_entitlements`; do not expose the database or use an admin role for the voice app.
- Keep Twilio inbound production flow pointed to the existing production actor. Configure a separate test number/Studio flow before making any calls to this new staging branch.

## Behavior

On Twilio's authenticated ConversationRelay `setup` message, read `msg.from`, normalize the phone, compute `HMAC-SHA256(REPLAY_HASH_SECRET, 'the-last-call-replay:' + e164Phone)` and check the active entitlement. If active, Marrow's opening line acknowledges the returned player; if not, it uses the existing opening. An anonymous caller or failed DB check gets the original opening. No payments are made and no DB writes occur.

**Security/launch limitations:** Caller ID can be spoofed, and buying a Pass by typing an arbitrary number does not prove ownership. Do not enforce paid access, disclose account details, or enable callbacks based only on this lookup. Before public redemption, implement phone ownership verification (e.g., verified code / secure player credential) and a signed server-side entitlement handoff to Ruth, plus a documented opt-in for callbacks. Since Ruth speaks earlier in Studio, her greeting cannot be personalized by this actor patch alone.

## Test checklist

1. Run `npm install`, `npm test`, and `npm run check` on this branch.
2. Keep `REPLAY_LOOKUP_ENABLED=false` to verify existing voice behavior unchanged.
3. On a **separate test deployment**, enable read-only lookup with valid connection secrets.
4. Call using a number with a sandbox Pass: Marrow uses returning-player opening. The number should not appear in logs.
5. Call without an entitlement: original opening. Call anonymously: original opening. Temporarily disconnect DB: original opening.
6. Confirm original narrative/death/survival routes work and no public Ruth/Twilio routing was modified.
7. **Only after tests pass:** plan server-side eligibility enforcement and Ruth-in-Studio personalization separately.
