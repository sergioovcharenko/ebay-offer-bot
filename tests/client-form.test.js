import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('addRule reads form fields explicitly by id instead of browser globals', () => {
  assert.match(source, /(?:document\.getElementById\(['"]name['"]\)|byId\(['"]name['"]\))\.value/);
  assert.match(source, /(?:document\.getElementById\(['"]product['"]\)|byId\(['"]product['"]\))\.value/);
  assert.doesNotMatch(source, /\bname\.value\b/);
});
