import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v5.js', import.meta.url), 'utf8');

test('multi-user mode requires PostgreSQL and creates user-scoped tables', () => {
  assert.match(source, /DATABASE_URL/);
  assert.match(source, /new Pool/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS users/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS sessions/);
  assert.match(source, /CREATE TABLE IF NOT EXISTS rules/);
  assert.match(source, /user_id uuid NOT NULL REFERENCES users/);
});

test('browser sessions use a secure HttpOnly cookie', () => {
  assert.match(source, /ebay_offer_session/);
  assert.match(source, /HttpOnly/);
  assert.match(source, /Secure/);
  assert.match(source, /SameSite=Lax/);
});

test('rules and offers are queried by current user id', () => {
  assert.match(source, /WHERE user_id=\$1 ORDER BY created_at DESC/);
  assert.match(source, /WHERE id=\$1 AND user_id=\$2/);
  assert.match(source, /SELECT \* FROM offers WHERE user_id=\$1/);
});

test('oauth state is bound to a browser session and user is upserted by eBay id', () => {
  assert.match(source, /oauth_states/);
  assert.match(source, /session_id/);
  assert.match(source, /ON CONFLICT\(ebay_user_id\) DO UPDATE/);
  assert.match(source, /UPDATE sessions SET user_id=\$1/);
});
