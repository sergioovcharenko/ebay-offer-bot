import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../run-v7-live.mjs', import.meta.url), 'utf8');

test('PlaceOffer includes the real client EndUserIP required by eBay', () => {
  assert.match(source, /function clientPublicIp\(req\)/);
  assert.match(source, /x-forwarded-for/);
  assert.match(source, /<EndUserIP>/);
  assert.match(source, /placeBestOffer\(userId,offer\.item_id,value,endUserIp\)/);
  assert.match(source, /requestOfferSend\(user\.id,m\[1\],body\.amount,req\)/);
});

test('missing client public IP fails safely before calling PlaceOffer', () => {
  assert.match(source, /Не вдалося визначити публічну IP-адресу користувача/);
});
