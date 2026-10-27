# Security

Status: Phase 9 — integrated system reviewed and hardened (ADR 0003–0010). See also `docs/known-limitations.md`.

## Principles
- The backend is the only security boundary; the UI is never trusted.
- Deny by default: authenticate, authorize by role, then verify ownership/relationship.
- No secrets in the repository; `.env` ignored, `.env.example` documents variables.

## Threat areas
| Area | Concern | Planned control (phase) |
|------|---------|-------------------------|
| Authentication | Credential theft, weak hashing, token theft/forgery | argon2id, JWT access token (HS256, 15 min) + rotating hashed refresh token, rate limiting (3; ADR 0015) |
| Authorization | Role bypass, manager acting outside reports | Role middleware + relationship checks in services (3, 4) |
| IDOR | Access to others' entries by id | Scope all queries by owner/relationship (3, 4) |
| Period lock bypass | Direct API calls, date change moving entries across lock, races | **Implemented (5):** service check + DB trigger + shared/exclusive advisory lock; tested (ADR 0005) |
| Input | Injection, oversized or malformed input | Zod validation, parameterized SQL (1+) |
| Errors | Information leakage | Central error handler, generic 500 (1) |
| Audit | Missing or tamperable records | **Implemented (5):** same-transaction writes + append-only trigger |
| Web | XSS/CSRF/CORS | helmet, CORS allow-list with credentials for the allow-listed origins only; HttpOnly cookie auth + SameSite=Lax + Origin check for CSRF (1, 3, 9; ADR 0019) |

## Open decisions
Unlock policy and who may unlock (Phase 5).

## Implemented controls (Phase 3) and how they are tested
| Control | Where | Tests |
|---------|-------|-------|
| argon2id password hashing; hash never returned | `src/auth/password.ts` | `auth.test.ts` (hash prefix, no secrets in responses) |
| Random refresh token, only SHA-256 hash stored; rotation (single-use, atomic); server-side logout; absolute expiry; inactive users rejected | `src/auth/session.service.ts`, `auth.service.ts` | `auth.test.ts` |
| JWT access token: HS256 pinned, issuer/audience/expiry checked, only `sub`+`sid` claims; re-checked against its session on every request (instant revocation) | `src/auth/access-token.ts`, `middleware/authenticate.ts` | `auth.test.ts` |
| `JWT_SECRET` required, min 32 chars | `config/env.ts` | `hardening.test.ts`, `env.test.ts` |
| Uniform login error (no user enumeration), timing equalization | `auth.service.ts` | `auth.test.ts` |
| Login throttling (failed attempts per IP) | `routes/auth.routes.ts` | `auth.test.ts` |
| Tokens only in HttpOnly, SameSite=Lax cookies (`__Host-at` / `__Secure-rt`, Secure in production); never in a body or JS storage; `Authorization: Bearer` refused | `auth/auth-cookies.ts`, `middleware/authenticate.ts` | `auth.test.ts`, `hardening.test.ts`, e2e `security.spec.ts` |
| CSRF: Origin allow-list on every state-changing request (on top of SameSite=Lax) | `middleware/origin-check.ts` | `auth.test.ts`, e2e `security.spec.ts`, `scripts/walkthrough.sh` |
| Role gate and 401 for anonymous | `middleware/authenticate.ts`, `authorize.ts` | `authorization.test.ts` |
| Ownership / direct-report scoping in the query (IDOR-safe), uniform 404 | `authorization/policies.ts`, `authorization.service.ts` | `authorization.test.ts` |
| Only the owner's direct manager may decide a submission | `assertCanDecideSubmission` | `submission-approval-policy.test.ts` |

## Added in Phase 4
| Control | Where | Tests |
|---------|-------|-------|
| Entry owner is always the caller; unknown body fields (e.g. `userId`) rejected | `validation/time-entries.schemas.ts` | `time-entries.test.ts` |
| Owner-only mutation of entries (403 visible / 404 not visible) | `time-entry.service.ts` | `time-entries.test.ts` |
| Approve/reject only by the owner's current direct manager; admin/owner/colleague 403, other manager 404, missing id indistinguishable | `authorization.service.ts` (called inside the transaction) | `submissions.test.ts` (HTTP) + `submission-approval-policy.test.ts` |
| Admin-only project/task writes | `routes/projects.routes.ts` | `projects.test.ts` |
| Frozen weeks reject create/update/delete/move | `time-entry.service.ts` | `submissions.test.ts` |
| Per-user advisory lock + status-guarded decision (races) | `lockUserTimesheet`, `decideSubmission` | concurrency tests in `time-entries.test.ts` / `submissions.test.ts` (mutation-checked) |

## Added in Phase 5
| Control | Where | Tests |
|---------|-------|-------|
| Period lock, service layer (create/update/delete/move; admins not exempt) | `assertDatesUnlocked` | `period-lock.test.ts` (asserts `enforcedBy: "service"`) |
| Period lock, database layer (trigger `LK001`, covers raw SQL) | migration `20261011160000_…` | `period-lock.test.ts` "database layer" |
| Lock-vs-edit race safety (shared/exclusive advisory lock per month) | trigger + `period-lock.service.ts` | deterministic and randomized race tests |
| Admin-only lock/unlock, mandatory unlock reason | `routes/locked-periods.routes.ts` | `period-lock.test.ts` |
| Audit trail in the same transaction; append-only (`LK002`); admin-only read | `audit.service.ts`, migration | `audit.test.ts` |
| Reject refused for weeks touching a locked month | `submission.service.ts` | `period-lock.test.ts` |

**Honest limits of the database layer:** verified that the role owning the tables can `ALTER TABLE … DISABLE TRIGGER` and `TRUNCATE`. The triggers stop application code and ordinary SQL, not a DBA or a compromised owner role. Production should separate the owner/migration role from a least-privilege app role. Other limits: month-granular global locks only; entries that already exist are not revalidated when a lock is placed; audit read access is admin-only (managers cannot see their reports' history).

## Known limitations (Phase 3)
- No background cleanup of expired sessions; no sliding expiry; no "log out everywhere" endpoint.
- Rate limiting is per IP in process memory (resets on restart; not shared across instances; behind a proxy `trust proxy` must be configured).
- No account lockout, password reset or user-administration API yet; demo users come from `npm run db:seed` (dev only).
- (Resolved in Phase 4) Approve/reject endpoints now exist and have HTTP-level tests.
- The `Secure` cookie flag is verified only by checking the Set-Cookie header in a test, not over real HTTPS.

## Known limitations (Phase 4)
- (Resolved in Phase 5) Audit writes and period locking now exist.
- A manager with no manager of their own cannot submit a timesheet (nobody can approve it); top-level approval is an open product question.
- No recall of a submitted week; no pagination (lists are capped: entries 1000, submissions 200).
- Rate limiting applies only to login.

## Added in Phase 6
| Control | Where | Tests |
|---------|-------|-------|
| Reports scoped by role in SQL (contributor / manager+reports / admin); out-of-scope `userId` is 404 | `visibleEntriesSql`, `report.service.ts` | `reports.test.ts` (8 groupings × 5 viewers vs an independent oracle) |
| Budget report admin-only | `routes/reports.routes.ts` | `reports.test.ts` |
| Report SQL: whitelisted `groupBy` fragments, every value parameterized, dates as text→`DATE`, row cap | `report.service.ts`, `validation/reports.schemas.ts` | injection attempts in `reports.test.ts` |
| Calendar dates never time-zone shifted | ADR 0006 | session/process time-zone tests |
| Client-caused framework errors are 4xx (413/415/400), transient DB errors are 503; no internals echoed | `middleware/error-handler.ts` | `review-regressions.test.ts` |
| Year bounds 2000–2100 on every date input | `validation/common.ts` | `review-regressions.test.ts` |
| Strict login body; submissions `userId` scope check | `auth.schemas.ts`, `submission.service.ts` | `review-regressions.test.ts` |

### Backend review (Phase 6)
An independent read-only review produced 8 findings; each was reproduced by a failing test before being fixed (18 of 20 regression tests failed first; the other two are guard tests): framework 4xx errors becoming 500, edit re-validation blocking correction of archived-project entries, the approval queue being crowded out by decided items, extreme dates reaching PostgreSQL, no handling of DB timeouts/deadlocks, doc/behaviour mismatches, submitting to a manager who can never decide, and a swallowed health-check cause. All are fixed. One reviewer note was **not** acted on: project budget/archive/date changes by admins are not audited (neither the docs nor the ADRs claim they are); it is the next auditability gap if billing integrity requires it.

## Known limitations (Phase 6)
- Admin changes to projects (budget, archive state, dates) are not written to the audit trail.
- Whole-table reports are O(rows) (~0.5 s at 600 k entries, ADR 0007).
- Reports count all logged hours, not only approved ones.

## Frontend notes (Phase 7)
- The UI is never a security boundary; all permission and lock rules stay on the backend.
- Tokens are in **HttpOnly cookies** (ADR 0019): JavaScript, and therefore XSS, cannot read them, and they never reach web storage. An XSS can still make requests from the victim's open tab, so the strict CSP and React's escaping stay essential. A reload and every tab of the browser profile share the session (one login per profile; use separate profiles to test several roles).
- CORS lists `FRONTEND_URL` with credentials; state-changing requests from any other `Origin` get 403 (CSRF defence in depth on top of `SameSite=Lax`).
- Users only see backend messages (`ApiError.message`) or a fixed generic text; raw exceptions and non-JSON error bodies are never rendered (tested).
- Build output includes source maps (`build.sourcemap`) for timesheets-billing; disable for a public deployment.
- Only `VITE_*` variables reach browser code; none holds a secret.

## Frontend notes (Phase 8)
- **UI mirrors, backend enforces.** Role-based navigation and "no access" pages are conveniences. Verified in a real browser: a direct `fetch` from the signed-in contributor's own session to write in a locked month was refused by the API (409 `PERIOD_LOCKED`) even though the UI hides the controls.
- **Session handling (ADR 0015, 0019):** the tokens are HttpOnly cookies the app never sees (it asks `/auth/me` who is signed in); the client makes one silent refresh on a 401 and replays the request, and a central handler drops the user if that fails; sign-out only forgets the user after the server confirmed (a failed logout leaves the user signed in with an error, because the session may still be valid); return-after-login accepts only same-app paths (no open redirect).
- **No sensitive text rendered from errors:** users see `ApiError.message` (backend text) or a fixed generic message; non-JSON error bodies and exception text are never shown.
- **Inputs:** client validation is for feedback only; backend field errors are mapped onto the form. Free text (notes, comments, reasons) is rendered as text by React (no `dangerouslySetInnerHTML` anywhere).
- Known gaps: no audit-trail or user-administration screen; source maps are emitted in production builds.

## Phase 9: integrated security review
Three independent sources: (1) a read-only reviewer who read the whole backend and the security-relevant frontend; (2) a live hostile-input probe (179 payloads: NUL bytes, huge/odd numbers, prototype keys, 5000-deep JSON, bad types, malformed cookies/paths/queries, odd methods and origins); (3) the committed browser end-to-end tests. Result: **no exploitable IDOR, injection, XSS, CSRF, period-lock or approval bypass was found**; the items below were real and are fixed (each reproduced by a failing test first; ADR 0010).

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| P1 | Medium | NUL characters in any text field → HTTP 500 (9 of 179 probes) | Fixed: central `reject-nul` middleware, 400 |
| P2 | Medium | Login throttle wrong behind a proxy (shared proxy IP, or spoofable XFF if `trust proxy: true`) | Fixed: `TRUST_PROXY` hop count, `true` rejected |
| P3 | Medium-Low | `Secure` cookie depended on `NODE_ENV`, defaulting to development | Fixed: default `production` |
| P4 | Medium-Low | No cache directives on authenticated JSON | Fixed: `no-store`, `Vary: Cookie`, no ETag |
| P5 | Low | Successful logins unthrottled (argon2 + session rows) | Fixed: coarse all-attempts limiter |
| P6 | Low | Cookie tossing (no `__Host-` prefix) | Fixed in production |
| P7 | Low | Budgets visible to every user via `/api/projects` | Fixed: admin-only (decision point, see ADR 0010) |

Verified sound by the reviewer and the e2e suite: session handling (hashed 256-bit token, rotation on login, server-side logout, deactivation takes effect immediately), uniform login errors, Origin allow-list and no state-changing GET, scope filters on every route (users, entries, timesheets, submissions, approvals, reports, locks, audit), approval rules incl. reassignment, three-way lock enforcement (service + trigger + error mapping) and append-only audit, parameterized SQL, no `dangerouslySetInnerHTML`/storage of tokens, safe return path after login.

### API documentation exposure (ADR 0013)
Swagger UI and `/api-docs.json` are unauthenticated and describe every route, role rule and error code, so they are **off in production by default** (`API_DOCS_ENABLED` unset) and are not proxied by the bundled nginx (only `/api/` is). They contain no secrets or environment values (a test scans the document). The UI is served by the app itself with the existing strict helmet CSP (`script-src 'self'`; no CDN, no inline script), unchanged. "Try it out" needs the API's own origin in `FRONTEND_URL` for write calls; the CSRF allow-list is deliberately not loosened for it.

### Production configuration checklist
1. `NODE_ENV=production` (also the default if unset). 2. Terminate TLS at the proxy; HSTS. 3. Serve the SPA and `/api` from one origin; leave `VITE_API_BASE_URL` at `/api`. 4. `FRONTEND_URL` = the exact public origin (no trailing slash). 5. `TRUST_PROXY` = exact hop count; the proxy must overwrite `X-Forwarded-For`. 6. Proxy-level rate limit for the whole API. 7. SPA headers at the proxy: CSP (`default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy`; do not publish `.map` files. 8. Leave `API_DOCS_ENABLED` unset (docs off) unless you intend to publish them. 9. Real environment variables (not `--env-file=.env`) in containers. 10. Separate DB owner and runtime roles. 11. A scheduled cleanup of expired sessions.
