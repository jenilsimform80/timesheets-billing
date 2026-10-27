# 0019. Tokens in HttpOnly cookies

Status: Accepted (added after Phase 10 at a reviewer's request; awaiting review). Supersedes ADR 0018 (sessionStorage) and the "no cookies / bearer header" part of ADR 0015. The token design itself (JWT access token + rotating refresh token + server-side session checked on every request) is unchanged.

## Context
ADR 0018 kept the tokens in `sessionStorage` so that an admin, a manager and a contributor could be signed in in different tabs of one browser. A reviewer challenged that: tokens in web storage are readable by any script on the page, and "several roles in one browser" is a developer convenience, not a product requirement. The expected approach is for the backend to set the token in an **HttpOnly cookie**.

## Decision
- **Two cookies, both `HttpOnly; SameSite=Lax`, `Secure` in production:**
  - access token (JWT, 15 min): `Path=/`, named `__Host-at` in production (the `__Host-` prefix makes browsers require Secure, `Path=/` and no `Domain`, which blocks "cookie tossing" from a sibling subdomain) and `at` in development;
  - refresh token (opaque, rotating, absolute expiry): `Path=/api/auth`, so the browser sends it only to the auth endpoints; `__Secure-rt` in production, `rt` in development (`__Host-` needs `Path=/`, so it cannot be used here).
- **Login and refresh return only `{ user }`.** Tokens never appear in a response body, so JavaScript cannot obtain them in any way. `Authorization: Bearer` is no longer accepted (one way in; a second would double the attack surface).
- **Refresh and logout read the refresh token from its cookie** (no request body). Logout always clears both cookies and answers 204; a failed refresh also clears them so the browser stops sending dead credentials.
- **CSRF protection returns**, because browsers now attach credentials automatically: `SameSite=Lax` plus the Origin allow-list check on every non-GET/HEAD/OPTIONS request (the middleware ADR 0015 deleted, restored from history). Requests without an Origin header (curl, tests, server-to-server) are not browser CSRF vectors and pass.
- **CORS** allows credentials for the allow-listed `FRONTEND_URL` only (never `*`); `Vary: Cookie` replaces `Vary: Authorization`.
- **Frontend** keeps nothing: `token-store.ts` is deleted. The client sends `credentials: 'include'` (in dev the API is another origin, `http://localhost:3000`, which is same-site with `http://localhost:5173`; in production nginx makes it one origin). Because JavaScript cannot see the cookies, "am I signed in?" is answered by asking the server (`GET /auth/me`, silently renewing an expired access cookie), which is also what keeps a reload signed in. Dev still requires opening the app on `localhost`, not `127.0.0.1`.
- New dependency: `cookie-parser` (+ `@types/cookie-parser`), the one removed in ADR 0015; small, long-established, and avoids hand-rolled cookie parsing.

## Trade-offs (the part to understand)
- **Gained:** an XSS can no longer read a token and carry it away to use from the attacker's machine (the main weakness of ADR 0018).
- **Not solved:** an XSS can still make requests *from the victim's open tab*, because the browser attaches the cookie. HttpOnly stops token theft, not abuse while the page is open. The strict CSP and React's escaping remain the defence.
- **Lost:** one login per browser profile. Cookies are shared by every tab, so signing in as a second user replaces the first. To use several roles at once, use separate browser profiles or a private window. (The e2e tests use isolated browser contexts, so they are unaffected.)
- **Cost:** CSRF is a concern again; it is handled by SameSite=Lax + the Origin check, and covered by tests.
- **Secure cookies and plain HTTP:** in production the cookies are `Secure`. Chrome and Firefox accept them on `http://localhost`; Safari and any non-localhost HTTP host do not. A real deployment needs HTTPS anyway; the Docker demo on `http://localhost:8080` works in Chrome/Firefox only.

## Alternative not taken
A single opaque session cookie (the pre-ADR-0015 design) would be simpler, since the JWT adds little when every request already checks the session in the database. Kept the JWT + refresh pair to limit the change to the transport; it can be simplified later.

## Verification
Backend 383 tests (cookie flags and names in development and production, no tokens in bodies, Bearer refused, forged/tossed/tampered cookies, refresh rotation and reuse through cookies, logout clearing cookies, cross-origin write refused, `Vary: Cookie`); frontend 251 unit tests; 30 Playwright tests (cookies are HttpOnly and invisible to `document.cookie` and web storage, reload and new tab stay signed in, copied cookies die after sign-out, foreign Origin refused); `scripts/walkthrough.sh` against a live backend.
