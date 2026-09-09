import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v5.js', import.meta.url), 'utf8');

test('search uses keywords plus optional size but does not require literal title matches after Browse search', () => {
  assert.match(source, /const query = `\$\{rule\.searchKeywords\} \$\{rule\.sizeVariant \|\| ''\}`\.trim\(\)/);
  const evaluate = source.match(/function evaluateMatch\(rule, listing\) \{([\s\S]*?)\n\}/);
  assert.ok(evaluate, 'evaluateMatch() should exist');
  assert.doesNotMatch(evaluate[1], /searchKeywords/);
  assert.doesNotMatch(evaluate[1], /sizeVariant/);
  assert.doesNotMatch(evaluate[1], /title/);
});

test('run response includes useful search diagnostics', () => {
  assert.match(source, /bestOffer:/);
  assert.match(source, /withinPrice:/);
  assert.match(source, /conditionMatch:/);
  assert.match(source, /eligible:/);
  assert.match(source, /offersPrepared:/);
  assert.match(source, /Best Offer:/);
  assert.match(source, /Підходять:/);
});

test('rules can be edited in UI and API', () => {
  assert.match(source, /Редагувати/);
  assert.match(source, /req\.method === 'PUT'/);
  assert.match(source, /UPDATE rules SET/);
  assert.match(source, /Зберегти/);
});

test('rule action buttons are rendered without broken escaped quotes', () => {
  assert.match(source, /run\(&quot;/);
  assert.match(source, /editRule\(&quot;/);
  assert.match(source, /deleteRule\(&quot;/);
  assert.doesNotMatch(source, /run\(\\\\''/);
});
