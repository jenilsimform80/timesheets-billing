# 0018. Tokens in sessionStorage (per tab)

Status: Superseded by 0019 (tokens now live in HttpOnly cookies). Was: Accepted (amends 0015: where the frontend keeps the tokens).

## Context
ADR 0015 kept both tokens in JavaScript memory only, so reloading the page signed the user out. The owner tests with an admin, a manager and a contributor open in the same browser and was signed out of each on every refresh.

## Decision
Store the token pair in `sessionStorage` (`src/api/token-store.ts`), behind the same module API. sessionStorage is **per tab**: a reload keeps the session, and a different tab or window has separate storage, so each role can be signed in in its own tab without affecting the others. It is cleared when the tab closes. `localStorage` and cookies are not used (they are shared by all tabs, which would make one login overwrite another).

## Trade-off (the part to understand)
Any script running on the page (XSS) can now read the tokens and carry them away, which memory-only storage prevented (XSS could only use them while the tab was open). Defences that remain: the strict CSP, React's escaping, short access tokens (15 min), single-use rotating refresh tokens, and server-side sessions that Sign out and password changes end. If this risk is not acceptable for a deployment, revert to memory-only (one file) and accept sign-out on reload.

## Consequences
- Duplicating a tab copies its storage; two tabs then share one refresh token, and since refresh tokens are single-use one of them will be signed out at its next refresh. Open a fresh tab and sign in instead.
- Storage failures (blocked, private mode) degrade to the old memory-only behaviour.
