import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v6.js', import.meta.url), 'utf8');

test('size/variant accepts comma-separated alternatives and searches each alternative', () => {
  assert.match(source, /function parseVariants\(/);
  assert.match(source, /split\(','\)/);
  assert.match(source, /for\s*\(const variant of variants\)/);
  assert.match(source, /Map\(\)/);
});

test('form shows concrete examples for product variants and offer fields', () => {
  assert.match(source, /9\.5, 34x32, L, 256GB/);
  assert.match(source, /placeholder="Напр\.: 150"/);
  assert.match(source, /placeholder="Напр\.: 80"/);
  assert.match(source, /placeholder="Напр\.: 5"/);
  assert.match(source, /placeholder="Напр\.: 100"/);
});

test('notifications have a visible enabled status and a test action', () => {
  assert.match(source, /Сповіщення увімкнені/);
  assert.match(source, /\/api\/notifications\/test/);
  assert.match(source, /Перевірити сповіщення/);
});
