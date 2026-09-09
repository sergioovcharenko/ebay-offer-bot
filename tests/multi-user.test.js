import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v5.js', import.meta.url), 'utf8');

test('browser sessions use a secure HttpOnly cookie', () => {
  assert.match(source, /ebay_offer_session/);
  assert.match(source, /HttpOnly/);
  assert.match(source, /Secure/);
  assert.match(source, /SameSite=Lax/);
});

test('rules and offers are scoped by current user', () => {
  assert.match(source, /userId/);
  assert.match(source, /x\.userId===user\.id/);
  assert.match(source, /rule\.userId!==user\.id/);
});

test('oauth state is bound to a session', () => {
  assert.match(source, /oauthStates/);
  assert.match(source, /sessionId/);
  assert.match(source, /state/);
});
