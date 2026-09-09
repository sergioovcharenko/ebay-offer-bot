# Multi-user eBay Offer Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one public eBay Offer Bot URL safe for many users, with per-user eBay auth, rules, offers, notifications, rule editing, and corrected search filtering.

**Architecture:** Add session-scoped ownership to all app data and PostgreSQL support behind `DATABASE_URL`, while retaining file fallback during rollout. eBay OAuth binds the returned eBay identity to the current browser session. Search relies on eBay query relevance and only post-filters reliable listing attributes.

**Tech Stack:** Node.js 22, built-in HTTP server, eBay Browse/OAuth APIs, PostgreSQL (`pg`), Railway.

**Spec:** `docs/superpowers/specs/2026-09-09-multi-user-ebay-design.md`

## Global Constraints
- Keep `GLOBAL_DRY_RUN=true`.
- Never return OAuth access/refresh tokens to browser APIs.
- Cookie: HttpOnly, Secure, SameSite=Lax.
- Every rule/offer API operation must be scoped to current user.
- App must still boot when `DATABASE_URL` is absent during migration.

---

### Task 1: Search diagnostics and rule editing

**Files:**
- Modify: `server-v4.js`
- Test: `tests/search-edit.test.js`

**Interfaces:**
- Produces `PUT /api/rules/:id`.
- Produces run response diagnostics: `fetched`, `bestOffer`, `conditionMatched`, `priceMatched`, `eligible`, `offersPrepared`.

- [ ] Write failing tests for search not requiring keywords/size literally in title, diagnostics, and rule update UI/API.
- [ ] Run tests and verify failure.
- [ ] Implement minimal changes.
- [ ] Run all tests and verify pass.
- [ ] Commit.

### Task 2: Session and per-user file fallback

**Files:**
- Modify: `server-v4.js`
- Test: `tests/multi-user.test.js`

**Interfaces:**
- Produces browser session cookie `ebay_offer_session`.
- Produces current-user resolver used by rules/offers/settings.

- [ ] Write failing tests for secure cookie and ownership scoping.
- [ ] Run tests and verify failure.
- [ ] Implement anonymous session creation and attach eBay identity after OAuth.
- [ ] Scope rules/offers/settings/seen data by user.
- [ ] Run tests and verify pass.
- [ ] Commit.

### Task 3: PostgreSQL production storage

**Files:**
- Modify: `package.json`
- Create: `storage.js`
- Modify: `server-v4.js`
- Test: `tests/storage.test.js`

**Interfaces:**
- `createStore({ databaseUrl, dataFile })` returns methods for sessions, users, ebay accounts, rules, offers, seen items, and settings.

- [ ] Write failing storage contract tests using file fallback.
- [ ] Add `pg` dependency.
- [ ] Implement schema bootstrap and storage adapter.
- [ ] Wire server to adapter.
- [ ] Run all tests and verify pass.
- [ ] Commit.

### Task 4: Railway rollout

**Files:** none unless deployment fixes are needed.

- [ ] Deploy code with `GLOBAL_DRY_RUN=true`.
- [ ] Confirm `/health`, rule CRUD, search diagnostics, and OAuth still work in fallback mode.
- [ ] Add Railway PostgreSQL and set `DATABASE_URL`.
- [ ] Redeploy and verify persistence across redeploy.
- [ ] Verify two separate browsers/eBay accounts do not see each other's rules or offers.
