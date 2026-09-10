import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v7.js', import.meta.url), 'utf8');

test('manual offer amount is not capped by the rule maximum', () => {
  assert.doesNotMatch(source, /value>rule\.maxOfferAmount/);
  assert.doesNotMatch(source, /value>Number\(offer\.listing_price\)/);
  assert.match(source, /if\(!\(value>0\)\)throw Error/);
});

test('PlaceOffer uses the authenticated buyer OAuth token and Best Offer action', () => {
  assert.match(source, /async function placeBestOffer\(/);
  assert.match(source, /X-EBAY-API-IAF-TOKEN/);
  assert.match(source, /X-EBAY-API-CALL-NAME['"]?:['"]PlaceOffer/);
  assert.match(source, /<Action>Offer<\/Action>/);
  assert.match(source, /<Quantity>1<\/Quantity>/);
  assert.match(source, /<MaxBid>/);
});

test('REST item ids are converted to legacy listing and variation ids', () => {
  assert.match(source, /function parseRestItemId\(/);
  assert.match(source, /v1\|/);
  assert.match(source, /legacyItemId/);
  assert.match(source, /variationId/);
});

test('successful PlaceOffer marks the candidate sent and stores the BestOffer id', () => {
  assert.match(source, /best_offer_id text NOT NULL DEFAULT ''/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS best_offer_id text NOT NULL DEFAULT ''/);
  assert.match(source, /status='OFFER_SENT'/);
  assert.match(source, /best_offer_id=\$\d+/);
  assert.match(source, /Пропозицію реально відправлено продавцю/);
});

test('eBay Trading errors are surfaced instead of pretending success', () => {
  assert.match(source, /parseTradingResponse/);
  assert.match(source, /Ack/);
  assert.match(source, /Errors/);
  assert.match(source, /PlaceOffer недоступний/);
});
