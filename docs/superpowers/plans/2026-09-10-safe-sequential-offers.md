# Safe Sequential Offers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-rule purchase quantity limit so the bot never has multiple live buyer offers for one unit at the same time, and stops the rule after the requested number of accepted purchases.

**Architecture:** Keep discovery separate from sending. Search may prepare many `OFFER_READY` candidates, but a rule may have at most one active sent offer per remaining requested unit. Store `target_quantity`, `accepted_quantity`, and offer status; when an offer is accepted increment the rule count and stop/disable the rule when the target is reached. Rejection/expiry advances to the next prepared candidate. Keep `GLOBAL_DRY_RUN=true` until live eBay buyer-offer capability is verified.

**Tech Stack:** Node.js 22, PostgreSQL, eBay Browse/OAuth, Railway, node:test.

**Spec:** User-approved conversation design: default quantity 1; sequential offer queue; accepted purchase stops rule at target.

## Global Constraints

- `GLOBAL_DRY_RUN=true` must remain enabled.
- Never send more than one live buyer offer at a time for a rule when target quantity is 1.
- Existing rules migrate with `target_quantity=1`.
- Search may prepare multiple candidates but must not count preparation as a purchase.
- Notifications must fire for sent/accepted/rejected/expired states when those states become available.

---

### Task 1: Define safety contract with tests

**Files:**
- Create: `tests/safe-sequential-offers.test.js`
- Modify: `server-v6.js`

- [ ] Write failing tests for quantity field/default, DB columns, sequential active-offer guard, and auto-stop at target.
- [ ] Run tests and verify the new tests fail.

### Task 2: Persist quantity and rule progress

**Files:**
- Modify: `server-v6.js`

- [ ] Add `target_quantity` and `accepted_quantity` columns with safe migrations/defaults.
- [ ] Add `targetQuantity` to validation, API mapping, create/edit forms, and rule cards.
- [ ] Run tests.

### Task 3: Enforce sequential live-offer safety

**Files:**
- Modify: `server-v6.js`

- [ ] Add a helper that checks whether a rule can send another live offer.
- [ ] Treat `OFFER_SENT` as active; do not allow another send while one is active for target quantity 1.
- [ ] Add accepted/rejected/expired status transition helpers/routes that advance or stop safely.
- [ ] Keep actual network buyer-offer submission disabled while dry-run is true.
- [ ] Run tests.

### Task 4: UX and notifications

**Files:**
- Modify: `server-v6.js`

- [ ] Add `Скільки одиниць купити` field, default `1`, with helper text explaining sequential behavior.
- [ ] Show progress `Куплено X із N` and paused/stopped state.
- [ ] Notify on test and future offer-state transitions.
- [ ] Run full test suite and deploy only after green tests.
