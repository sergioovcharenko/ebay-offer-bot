# Multi-user eBay Offer Bot Design

## Goal
Turn the current single-user eBay Offer Bot into one public web app URL that many people can use with their own eBay accounts, while keeping every user's rules, offers, OAuth credentials, session, and notifications isolated.

## Safety
- Keep `GLOBAL_DRY_RUN=true` throughout the migration.
- Do not expose eBay access or refresh tokens through API responses.
- Use HttpOnly, Secure, SameSite=Lax cookies for browser sessions.
- OAuth state must be bound to a browser session and expire.

## Storage
Production mode uses PostgreSQL through `DATABASE_URL`. The app creates/updates its own schema at startup. A file-backed compatibility mode remains available when `DATABASE_URL` is absent so an existing deployment can still boot during migration.

Core records:
- users: app user id and eBay identity metadata
- sessions: opaque browser session id -> user id
- oauth_states: temporary eBay OAuth state -> browser session
- ebay_accounts: encrypted-at-rest is preferred later; initially DB access is private and tokens are never returned to the client
- rules: owned by one user
- offers: owned by one user and one rule
- seen_items: per-user/per-rule deduplication
- user_settings: per-user notification settings

## Authentication flow
A visitor receives an anonymous browser session cookie. Pressing “Увійти через eBay” creates OAuth state tied to that session. After eBay redirects back, the app exchanges the code, reads eBay identity, upserts that eBay account as an app user, and attaches the current browser session to that user. All subsequent `/api/*` reads/writes are scoped by the session's user id.

## Search behavior
`Ключові слова` is the canonical search input. `Товар / модель` is display-only and mirrors keywords. The eBay Browse query is built from keywords plus optional size/variant. Post-search filtering is limited to business constraints that can be reliably known from Browse results: price, requested condition, and Best Offer availability. Size is not required to be present literally in the title. The run result returns diagnostics counts.

## Rule editing
Each rule card gets `Редагувати`. The form loads the rule values and changes the primary action to `Зберегти`. Saving calls `PUT /api/rules/:id`, preserving ownership and rule id.

## Compatibility and rollout
The server must continue to boot without PostgreSQL. PostgreSQL is required before calling the deployment fully production-ready for multiple people because file storage is not durable across Railway redeploys. Existing single-user file data is not automatically shared into new users; migration can be handled separately if needed.
