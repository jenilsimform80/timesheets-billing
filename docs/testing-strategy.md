# Testing Strategy

Status: Phase 0 — strategy only; no tests exist yet.

## Levels
- **Unit**: pure business rules (hour validation, week boundaries, status transitions).
- **Integration**: Supertest against the Express app with a dedicated test PostgreSQL database.
- **Concurrency**: parallel lock-vs-edit operations asserting the immutability invariant.
- **Frontend**: React Testing Library component and integration tests (Phases 7–8).
- **End-to-end workflows**: manual or scripted verification in Phase 9.

## Mandatory scenarios (Phase 5 and later)
Create/update/delete in a locked period rejected; another user's entry rejected; concurrent lock/edit preserves the invariant; tests show which layer enforces it.

## Rules
- Positive and negative cases for every business rule; assert persisted state, not only the response.
- Test DB is separate from dev data; state reset between tests.
- Quality gates per package: type-check, lint, format check, tests. Results are reported only if actually run.

## Tooling
Backend (confirmed Phase 1): Vitest + Supertest; `npm run check` runs typecheck, lint, format check and tests. Frontend (Phase 7): Vitest + React Testing Library.

## Status after Phase 10
New: `frontend/e2e/csp.spec.ts` (every screen under the strict CSP: zero `securitypolicyviolation` events; mutation-checked with raw markup carrying a style attribute, which is caught as `style-src-attr`; React `style` props go through the CSSOM and are not CSP-governed) and e2e parameterization (`E2E_EXTERNAL_SERVERS`, `E2E_BASE_URL`, `E2E_COOKIE_NAME`, `E2E_EXPECT_CSP`) so the **whole 30-test suite was also run against a production-mode backend (Secure `__Host-sid` cookie) behind a proxy emulator applying the real nginx header values: 30 passed**. `scripts/walkthrough.sh` (six scenarios, every outcome asserted) was run against the same stack. Fresh-setup verification followed `docs/deployment.md` section B on a clean copy with new databases. Not tested: the Docker artifacts (see `known-limitations.md`).

## Status after Phase 9
> **Cookie design restored by ADR 0019 (HttpOnly cookies; ADR 0015's bearer transport and ADR 0018's sessionStorage are superseded).** Current counts: backend 22 files / 383 tests, frontend 21 files / 251 unit tests, 30 e2e tests (sign-in through the UI; the browser keeps HttpOnly cookies, so reloads stay signed in). The paragraph below was written for the bearer design:
>
> **Superseded in part by ADR 0015 (bearer tokens):** the cookie, `__Host-sid`, Origin-check and `E2E_COOKIE_NAME` details below describe the earlier cookie design. Current counts after that change: backend 22 files / 359 tests, frontend 20 files / 238 unit tests, 30 e2e tests (sign-in through the UI; `appGoto` navigates without reloading because tokens are memory-only).

Totals: backend 18 files / 285 tests; frontend 17 files / 186 unit/integration tests + 8 opt-in live contract tests; **29 end-to-end browser tests** (`cd frontend && npm run e2e`: real Chrome + real Vite + real backend + disposable `*_test` database, ≈ 35 s). New this phase: `backend/tests/hostile-input.test.ts` (NUL bytes and other hostile payloads), `backend/tests/hardening.test.ts` (headers/cache, fail-safe env, `__Host-` cookie, proxy trust, login limiters, budget visibility), and the four Playwright specs (workflow, locking, security, time zones/reports). Mutation-checked (all caught): the new hardening (6), NUL middleware removal (9 tests fail), and e2e (service lock check disabled → `enforcedBy` changes to `database`; viewer-local day labels fail in Los Angeles/Kiritimati; CSRF check removed). Test-quality fixes made on the way: a timing race in a reports test (now waits for the request), a stale-fixture date in the hostile-input test, and the e2e suite's 5 s-per-request delay (Playwright + `localhost`, see ADR 0010). Quality gates: backend and frontend `npm run check`, `npm audit` (0 vulnerabilities in both), both builds.

## Status after Phase 8
Frontend: 17 files / 186 tests (Vitest + RTL + jsdom). `mockApi` fails any unmocked request; write flows use stateful fake backends. Every screen is covered for positive paths, client validation (no request sent when invalid), backend refusals shown to the user (period locked, daily limit, frozen week, conflicts, forbidden/not-found), empty/error/retry states and role gating (guarded screens make no API call for the wrong role). Defects the tests found while writing them: forms closing on a failed save (double result wrapping), the whole page flashing to a spinner after each save (fixed with stale-while-revalidate), sign-out clearing the user even when the server failed, and an unhandled rejection on failed logout.
Mutation-checked (all caught): saving failure closing the form, frozen week / locked month still editable, any hours accepted, PATCH sending unchanged fields, reject/unlock without a reason, role guard open, central 401 handler missing, report grouping order, budget bar overflow, local sign-out on server failure.
Beyond unit tests: (1) `npm run test:live` drives the wrappers against a real backend for three roles (8 tests; its six audit records verified in the database); (2) a scripted real-browser run (Chrome via Playwright, from a scratch directory, not committed) completed 14 steps end to end: anonymous redirect, wrong password, admin creates a project/task, contributor logs and submits hours (backend daily-limit rule shown), manager approves, admin locks the month, edit controls disappear, a direct API write is refused with 409 PERIOD_LOCKED, report and budget values match, manager gets "no access" on the budgets page. The run caught two issues unit tests could not (a missing favicon causing a 404 console error; layout polish). Phase 9 should turn that browser flow into committed end-to-end tests.

## Status after Phase 7
Frontend: `frontend/` runs 7 files / 48 tests (Vitest + React Testing Library + jsdom, `fetch` stubbed): API client (headers, credentials, error mapping, no leakage of non-JSON bodies, abort), env parsing, health wrappers (503 "database down" is data, not an error), `useAsync` (reload, abort on unmount, superseded requests ignored), UI states, routing (real route table, active link, not-found, crashing page → error page) and the status-page integration (loading, healthy, db down, API unreachable → retry → recovered, backend error message, refresh). Mutation-checked: dropping `credentials: 'include'`, the 503 handling, the stale-response guard, error-text redaction, the empty state and the route `errorElement` each fail specific tests (one gap was found and fixed: the first version of the crash test used its own route table and did not test the production `errorElement`). Connectivity of the real chain (browser origin → Vite proxy → API → DB, cookie round trip, CSRF origin check) was verified by running both servers and issuing requests through the proxy.

## Status after Phase 6
`npm test`: 16 files / 245 tests (real PostgreSQL). Phase 6 adds `reports.test.ts` (40: hand-checked values, an independent oracle across 8 groupings × 5 viewers, visibility, validation incl. SQL-injection attempts, budget thresholds, time-zone independence) and `review-regressions.test.ts` (20: one per reviewer finding, written to fail first). Report mutations that were caught: widened manager scope, exclusive range end, missing billable filter, `LEFT JOIN`→`JOIN`, open budget route, time-zone-sensitive month bucketing. Index decisions are evidence-based (ADR 0007).

## Status after Phase 5
`npm test`: 14 files / 183 tests (real PostgreSQL). Phase 5 adds `period-lock.test.ts` (24) and `audit.test.ts` (9). The suite distinguishes layers: API tests assert `details.enforcedBy = "service"`; raw-SQL tests assert SQLSTATE `LK001`/`LK002` from the database. Race tests include deterministic ones (an open transaction holds a write or the lock) and a randomized one. All were mutation-checked: removing the trigger's shared lock, the trigger, the service check, the audit write, or the append-only guard each fails specific tests (see ADR 0005).

## Status after Phase 4
`npm test` runs 12 files / 150 tests against the real PostgreSQL test database (HTTP via Supertest, in-process app). Suites run one file at a time because they share one database; the run takes ~35 s mostly because every login verifies an argon2id hash. Concurrency tests (daily limit, submit-vs-edit, concurrent decisions) were mutation-checked by deliberately removing the lock / guards and confirming the tests fail.
