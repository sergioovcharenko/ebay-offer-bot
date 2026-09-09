import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v5.js', import.meta.url), 'utf8');

test('post-filter checks only best offer, configured price, and configured condition', () => {
  const evaluate = source.match(/function evaluateMatch\(rule, listing\) \{([\s\S]*?)\n\}/);
  assert.ok(evaluate, 'evaluateMatch() should exist');
  assert.match(evaluate[1], /BEST_OFFER/);
  assert.match(evaluate[1], /maxListingPrice/);
  assert.match(evaluate[1], /rule\.condition/);
  assert.doesNotMatch(evaluate[1], /title/);
});

test('eBay query itself carries keywords and optional size', () => {
  assert.match(source, /const query = `\$\{rule\.searchKeywords\} \$\{rule\.sizeVariant \|\| ''\}`\.trim\(\)/);
  assert.match(source, /new URLSearchParams\(\{ q: query, limit: '50' \}\)/);
});

test('new candidates are de-duplicated per user and rule', () => {
  assert.match(source, /PRIMARY KEY \(user_id, rule_id, item_id\)/);
  assert.match(source, /ON CONFLICT DO NOTHING RETURNING item_id/);
});
