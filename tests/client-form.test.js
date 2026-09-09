import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v5.js', import.meta.url), 'utf8');

test('search keywords are the primary rule input and name/product are derived', () => {
  assert.match(source, /const searchKeywords = String\(x\.searchKeywords \|\| ''\)\.trim\(\)/);
  assert.match(source, /const productName = String\(x\.productName \|\| searchKeywords\)\.trim\(\)/);
  assert.match(source, /const name = String\(x\.name \|\| searchKeywords\)\.trim\(\)/);
});

test('form has required rule fields and direct eBay product links', () => {
  assert.match(source, />Ключові слова</);
  assert.match(source, />Розмір \/ варіант</);
  assert.match(source, />Початкова пропозиція</);
  assert.match(source, /Відкрити товар на eBay/);
});

test('successful save clears the rule form', () => {
  assert.match(source, /function resetRuleForm\(\)/);
  assert.match(source, /resetRuleForm\(\);await load\(\)/);
});

test('rules can be edited and deleted from UI', () => {
  assert.match(source, /function editRule\(id\)/);
  assert.match(source, /Редагувати/);
  assert.match(source, /method:editingId\?'PUT':'POST'/);
  assert.match(source, /async function deleteRule\(id\)/);
  assert.match(source, /Видалити/);
});

test('notification helper and persisted iOS-style themes remain', () => {
  assert.match(source, /Підключити сповіщення/);
  assert.match(source, /notifyTopic/);
  assert.match(source, /localStorage\.setItem\('theme'/);
  assert.match(source, /toggleTheme/);
  assert.match(source, /prefers-color-scheme/);
});
