import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v6.js', import.meta.url), 'utf8');

test('v6 frontend loads settings and uses event delegation instead of fragile inline rule handlers', () => {
  assert.match(source, /api\('\/api\/settings'\)/);
  assert.match(source, /data-action="run"/);
  assert.match(source, /data-action="edit"/);
  assert.match(source, /data-action="delete"/);
  assert.match(source, /addEventListener\('click'/);
  assert.doesNotMatch(source, /onclick="run\(/);
  assert.doesNotMatch(source, /onclick="editRule\(/);
  assert.doesNotMatch(source, /onclick="deleteRule\(/);
});

test('v6 keeps multi-user postgres and eBay OAuth endpoints', () => {
  assert.match(source, /new Pool/);
  assert.match(source, /\/auth\/ebay\/login/);
  assert.match(source, /\/auth\/ebay\/callback/);
  assert.match(source, /WHERE user_id=\$1/);
});
