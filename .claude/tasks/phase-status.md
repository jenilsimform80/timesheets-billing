# Phase Status

**Active phase:** Phase 10 — Delivery and Walkthrough. Artifacts, docs and verifiable checks are complete; **Docker verification is blocked** (no container runtime available; installing needs sudo).
**Next step:** on a machine with Docker run `docker compose config` and `docker compose up --build`, then `scripts/walkthrough.sh` and the role-separation checks in `docs/deployment.md`; owner to approve project closure.

| Phase | Name | Status |
|-------|------|--------|
| 0 | Workspace and Engineering Foundation | Complete — approved |
| 1 | Backend Foundation | Complete — approved |
| 2 | PostgreSQL and Prisma | Complete — approved |
| 3 | Authentication and Authorization | Complete — approved |
| 4 | Timesheet and Project APIs | Complete — approved |
| 5 | Period Locking and Audit Trail | Complete — approved |
| 6 | Reports and Backend Completion | Complete — approved |
| 7 | Frontend Foundation | Complete — approved |
| 8 | Frontend Features | Complete — approved |
| 9 | Integration, Security and Final Quality | Complete — approved |
| 10 | Delivery and Walkthrough | Incomplete — Docker verification blocked |

## Decisions
- Structure lives at the workspace root (no nested `poc/`).
- Git initialized locally on `main`; remote `origin` = `git@github.com:jenilsimform80/timesheets-billing.git`; no commits or pushes made.
- `docs/requirements.md` derived from the prompt only, marked "Derived from prompt — original specification unverified."
- `.env.example`, `backend/`, `frontend/`, `docker-compose.yml` deliberately deferred to the phases that need them.

- Phase 1: Vitest chosen as test runner; TypeScript pinned to 6.0.x (ADR 0001); Express 5; `.env` loaded via Node `--env-file` (no dotenv dependency); validated request data lives on `res.locals.validated` because Express 5 `req.query` is read-only.
- Phase 2: Prisma 7.10.0 + `@prisma/adapter-pg`; deletes RESTRICT with soft-archive flags; `users.manager_id`; global calendar-month locks; ISO Monday weeks (assumption); hand-written CHECK constraints in the init migration; separate `timesheets_test` database guarded by a `_test` name check; npm `overrides` for two vulnerable CLI dependencies (ADR 0002).
- Phase 3: server-side cookie sessions (hashed token in new `sessions` table, migration `add_sessions`); argon2id; Origin-allow-list CSRF check; failed-login rate limit; scope rules as Prisma `where` filters; admins cannot approve; out-of-scope = 404; demo users via `npm run db:seed` (dev only). See ADR 0003.
- Phase 4 (assumptions, ADR 0004): 24 h/day hard cap, 10 h/day and 48 h/week warnings, quarter-hour steps; submitted/approved weeks frozen, rejected weeks reopen; admin manages projects; owner-only entry mutation; per-user advisory lock serializes timesheet writes.
- Phase 5 (assumptions, ADR 0005): global calendar-month locks; admin-only unlock with mandatory reason; admins not exempt; two enforcement layers (service + trigger `LK001`) sharing a per-month shared/exclusive advisory lock; audit written in the same transaction and append-only (`LK002`); reject refused for weeks touching a locked month.
- Phase 6 (assumptions, ADR 0006/0007): role-scoped hours report with any combination of contributor/project/month; admin-only budget report (WARNING ≥ 80 %, OVER > 100 %); calendar dates never time-zone converted, years 2000–2100; no new index (measured), manager scope rewritten as `IN (subquery)`; independent review findings fixed (4xx for framework errors, 503 for transient DB errors, approval queue defaults to pending, manager must be an active MANAGER at submit, strict login body).
- Phase 7 (ADR 0008): React 19 + Vite 8 + TypeScript 6.0 (strict) + React Router **7.x** (8.x needs Node ≥ 22.22; this machine has 22.18); plain CSS Modules; Vitest + RTL; same-origin API access via a Vite proxy with `credentials: 'include'`; one API client; `useAsync` + `AsyncView` for the four standard states.
- Phase 8 (ADR 0009): feature folders; central 401 handling; sign-out clears the user only after server confirmation; role-aware nav as a convenience; `useAsync` is stale-while-revalidate; forms send only changed fields; day-by-day week view instead of a project×day grid (the backend allows several entries per project/task/day); no notifications.
- Phase 9 (ADR 0010): fail-safe `NODE_ENV=production` default, `__Host-sid` cookie in production, `TRUST_PROXY` hop count, `no-store` + `Vary: Cookie`, coarse login limiter, central NUL rejection, budgets hidden from non-admins; committed Playwright e2e suite on a guarded disposable database.
- Phase 10 (ADR 0011): Compose with db/migrate/backend/web(+seed), nginx same-origin proxy with CSP and security headers, two database roles (owner for migrations, non-owner for the app), runtime image `--omit=dev --omit=optional` (91 MB vs 344 MB), runnable `scripts/walkthrough.sh`; e2e parameterized to test an external (production-like) stack and a CSP-violation test added.

- Post-Phase 10 change (ADR 0012, requested by the owner): admin-only user administration — create, edit, deactivate/reactivate, reset password (`/users` page) plus self-service change password (`/account`). Not a numbered phase; awaiting the owner's review.

- Post-Phase 10 change (ADR 0013, requested by the owner): Swagger UI at `/api-docs` and OpenAPI JSON at `/api-docs.json` (documentation only; off in production by default; new dependency `swagger-ui-express`). Awaiting the owner's review.

- Post-Phase 10 change (ADR 0014, requested by the owner): restricted projects with members, managers create tasks and assign them to themself/direct reports, managers may report to another manager. Not a numbered phase; awaiting the owner's review.

- Post-Phase 10 change (owner request, no backlog id): show/hide (eye) toggle on the login password field via a reusable `PasswordField` in `FormControls`; Playwright `getByLabel('Password')` calls made exact because the toggle's label also contains "password". Applied to the login, new-user, reset-password and account (change password) forms; each toggle is named after its field ("Show new password"). Awaiting the owner's review.

- Post-Phase 10 change (ADR 0015, requested by the owner): cookie sessions replaced by bearer tokens — HS256 JWT access token (15 min, claims `sub`+`sid`, re-checked against its `sessions` row on every request) plus a single-use rotating refresh token (the session row, hashed); `POST /api/auth/refresh`; logout takes the refresh token; cookies, `cookie-parser` and the Origin check removed; new dependency `jose`; new required env `JWT_SECRET` (also in `docker-compose.yml`) and `ACCESS_TOKEN_TTL_MINUTES`; frontend keeps tokens in memory only (reload signs out), silent single-flight refresh + replay on 401; e2e now signs in through the UI and navigates with `appGoto`; e2e ports overridable (`E2E_BACKEND_PORT`/`E2E_FRONTEND_PORT`). Awaiting the owner's review.
- Post-Phase 10 change (ADR 0019, requested by a reviewer): the tokens moved into HttpOnly cookies (`__Host-at`/`__Secure-rt` in production, `at`/`rt` in dev; `Secure`, `SameSite=Lax`; refresh cookie `Path=/api/auth`) set by the backend; login/refresh return only `{ user }`; `Authorization: Bearer` no longer accepted; refresh/logout read the refresh cookie (no body); Origin-check CSRF middleware restored; CORS `credentials: true`; `Vary: Cookie`; `cookie-parser` re-added; frontend `token-store.ts` deleted, client uses `credentials: 'include'` and `/auth/me` on load (reload stays signed in; one login per browser profile). Supersedes ADR 0018. Verified: backend 383 tests, frontend 251 unit tests, 30 e2e tests, `scripts/walkthrough.sh` (one stale assertion fixed: admin approval is 404 per ADR 0016). Awaiting review.

## Environment findings
Node v22.18.0, npm 11.5.2, git 2.34.1, Claude Code 2.1.246, PostgreSQL 14.24 (role `timesheets` and databases `timesheets_dev`/`timesheets_test` created by the owner; connectivity verified), Docker not installed.

## Blockers and risks
- Original spec not provided (POC-DOC-001). Phase 4–6 rule values are assumptions.
- npm intermittently drops Vitest's native binding from the lockfile when dependencies change; fix is deleting `node_modules` and `package-lock.json` and running `npm install`.
- Docker missing — needed by Phase 10.
- Dev gotcha: open the frontend at `http://localhost:5173`, not `127.0.0.1` (backend `FRONTEND_URL` allow-list; otherwise POST/PATCH/DELETE get 403).
- The table-owner role can disable the lock trigger (verified); production needs separate owner and app roles (ADR 0005).
- Project skills `security-review` and `code-review` share names with built-in skills; if the wrong one triggers, rename to `poc-` prefixed names.
- Open decisions are listed in `docs/requirements.md` and `docs/architecture.md`.

## Remaining work
None in the code. To finish Phase 10 someone with Docker must run, and fix anything that fails in: `docker compose config`; `docker compose up --build` (watch `migrate` complete, `backend` become healthy); open http://localhost:8080; `SEED_PASSWORD=… docker compose --profile demo run --rm seed`; `BASE_URL=http://localhost:8080 DEMO_PASSWORD=… scripts/walkthrough.sh`; and the three role-separation commands in `docs/deployment.md`. Then the owner can close the project.
