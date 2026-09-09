import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('search keywords are the primary rule input and name/product can be derived', () => {
  assert.match(source, /const searchKeywords=String\(x\.searchKeywords\|\|''\)\.trim\(\)/);
  assert.match(source, /const productName=String\(x\.productName\|\|searchKeywords\)\.trim\(\)/);
  assert.match(source, /const name=String\(x\.name\|\|searchKeywords\)\.trim\(\)/);
});

test('form explains fields and offer cards include a direct product link', () => {
  assert.match(source, />Ключові слова</);
  assert.match(source, />Розмір \/ варіант</);
  assert.match(source, />Початкова пропозиція</);
  assert.match(source, /Відкрити товар на eBay/);
});

test('successful rule creation clears the rule form', () => {
  assert.match(source, /function resetRuleForm\(\)/);
  assert.match(source, /resetRuleForm\(\);await load\(\)/);
});

test('rules can be deleted from UI and API', () => {
  assert.match(source, /async function deleteRule\(id\)/);
  assert.match(source, /method:'DELETE'/);
  assert.match(source, /\/api\/rules\//);
  assert.match(source, /Видалити/);
});

test('notification setup has a direct helper button and instructions', () => {
  assert.match(source, /Підключити сповіщення/);
  assert.match(source, /ntfy/);
  assert.match(source, /notifyTopic/);
});

test('UI supports persisted light and dark iOS-style themes', () => {
  assert.match(source, /data-theme/);
  assert.match(source, /localStorage\.setItem\(['"]theme['"]/);
  assert.match(source, /toggleTheme/);
  assert.match(source, /prefers-color-scheme/);
});
