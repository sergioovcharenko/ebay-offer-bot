import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v6.js', import.meta.url), 'utf8');

test('offer cards expose gallery controls without opening eBay', () => {
  assert.match(source, /\/api\/offers\/([^/]+)\/gallery/);
  assert.match(source, /additionalImages/);
  assert.match(source, /data-action="gallery-prev"/);
  assert.match(source, /data-action="gallery-next"/);
  assert.match(source, /photoCounter/);
});

test('each offer card has editable amount and per-item send action', () => {
  assert.match(source, /data-offer-amount/);
  assert.match(source, /Надіслати пропозицію/);
  assert.match(source, /\/api\/offers\/([^/]+)\/send/);
  assert.match(source, /Реальне надсилання вимкнено/);
});

test('offers dashboard shows active offers, accepted purchases and multiple-offer warning', () => {
  assert.match(source, /Активні пропозиції/);
  assert.match(source, /Успішні покупки/);
  assert.match(source, /кілька продавців можуть погодитися/);
});

test('offer cards show human-readable statuses', () => {
  assert.match(source, /Не відправлено/);
  assert.match(source, /Відправлено/);
  assert.match(source, /Прийнято/);
  assert.match(source, /Відхилено/);
  assert.match(source, /Контрпропозиція/);
});
