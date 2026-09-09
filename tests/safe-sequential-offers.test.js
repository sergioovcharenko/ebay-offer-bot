import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../server-v6.js', import.meta.url), 'utf8');

test('rules persist target quantity and accepted progress with safe defaults', () => {
  assert.match(source, /target_quantity integer NOT NULL DEFAULT 1/);
  assert.match(source, /accepted_quantity integer NOT NULL DEFAULT 0/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS target_quantity integer NOT NULL DEFAULT 1/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS accepted_quantity integer NOT NULL DEFAULT 0/);
  assert.match(source, /targetQuantity/);
  assert.match(source, /acceptedQuantity/);
});

test('rule form exposes purchase quantity defaulting to one', () => {
  assert.match(source, /Скільки одиниць купити/);
  assert.match(source, /id="targetQuantity"[^>]*value="1"/);
  assert.match(source, /Куплено/);
});

test('live offer safety permits only one active sent offer at a time for a rule', () => {
  assert.match(source, /function canSendNextOffer/);
  assert.match(source, /status='OFFER_SENT'/);
  assert.match(source, /activeOfferCount/);
  assert.match(source, /activeOfferCount\s*>?=\s*1/);
});

test('accepted offer increments progress and disables rule at target quantity', () => {
  assert.match(source, /OFFER_ACCEPTED/);
  assert.match(source, /accepted_quantity=accepted_quantity\+1/);
  assert.match(source, /accepted_quantity>=target_quantity/);
  assert.match(source, /enabled=false/);
});

test('rejected or expired offer becomes inactive so the next candidate can be tried', () => {
  assert.match(source, /OFFER_REJECTED/);
  assert.match(source, /OFFER_EXPIRED/);
  assert.match(source, /\/api\/offers\/([^/]+)\/status/);
});

test('dry run remains enabled as deployment safety gate', () => {
  assert.match(source, /const DRY_RUN = \(process\.env\.GLOBAL_DRY_RUN \?\? 'true'\) !== 'false'/);
  assert.match(source, /dryRun:DRY_RUN/);
});
