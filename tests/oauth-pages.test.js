import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v5.js', import.meta.url), 'utf8');

test('production OAuth helper pages exist for eBay redirect settings', () => {
  assert.match(source, /p === '\/privacy'/);
  assert.match(source, /p === '\/auth\/ebay\/declined'/);
  assert.match(source, /Privacy Policy/);
  assert.match(source, /Авторизацію eBay скасовано/);
});

test('OAuth uses RuName and minimal configured scopes', () => {
  assert.match(source, /redirect_uri: EBAY_RUNAME/);
  assert.match(source, /commerce\.identity\.readonly/);
  assert.match(source, /scope: SCOPES\.join\(' '\)/);
});
