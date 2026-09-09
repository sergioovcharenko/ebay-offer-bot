import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v4.js', import.meta.url), 'utf8');

test('search uses keywords plus size but does not require them literally in title after Browse search', () => {
  assert.match(source, /rule\.searchKeywords.*rule\.sizeVariant/s);
  assert.doesNotMatch(source, /for\(const w of txt\(r\.searchKeywords\).*t\.includes\(w\)/s);
  assert.doesNotMatch(source, /r\.sizeVariant&&!t\.includes\(txt\(r\.sizeVariant\)\)/);
});

test('run response includes search diagnostics', () => {
  assert.match(source, /bestOffer/);
  assert.match(source, /conditionMatched/);
  assert.match(source, /priceMatched/);
  assert.match(source, /eligible/);
});

test('rules can be edited in UI and API', () => {
  assert.match(source, /Редагувати/);
  assert.match(source, /PUT/);
  assert.match(source, /\/api\/rules\//);
  assert.match(source, /Зберегти/);
});
