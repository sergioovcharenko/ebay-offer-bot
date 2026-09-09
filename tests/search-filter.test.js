import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v4.js', import.meta.url), 'utf8');

test('search query uses keywords plus optional size, but post-filter does not require title to contain every search word or size', () => {
  assert.match(source, /const token=await appAccessToken\(\),q=encodeURIComponent\(`\$\{rule\.searchKeywords\} \$\{rule\.sizeVariant\|\|''\}`\.trim\(\)\)/);
  const evaluateMatch = source.match(/function evaluateMatch\(r,l\)\{([\s\S]*?)\n\}/);
  assert.ok(evaluateMatch, 'evaluateMatch() should exist');
  assert.doesNotMatch(evaluateMatch[1], /searchKeywords/);
  assert.doesNotMatch(evaluateMatch[1], /sizeVariant/);
});

test('run result explains why eBay results were filtered', () => {
  assert.match(source, /bestOffer:/);
  assert.match(source, /withinPrice:/);
  assert.match(source, /conditionMatch:/);
  assert.match(source, /eligible:/);
  assert.match(source, /offersPrepared:/);
  assert.match(source, /Best Offer:/);
  assert.match(source, /Підходять:/);
});
