import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('addRule reads form fields explicitly by id instead of browser globals', () => {
  assert.doesNotMatch(source, /\bname\.value\b/);
});

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
