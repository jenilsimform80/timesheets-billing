# Architecture overview

Status: end of Phase 10. Requirements are derived from the project brief ("Derived from prompt - original specification unverified", see `requirements.md`); policy values are documented assumptions (`known-limitations.md`).

## Components
```
 Browser (React SPA)  ──►  nginx (serves SPA, adds CSP, proxies /api)  ──►  Express API  ──►  PostgreSQL
   React 19 · TypeScript · Vite 8        same origin as the API              Node 22 · TS strict      14+
   React Router 7 · CSS Modules          unprivileged, :8080                 Zod · Prisma 7 · argon2
```
- **Frontend** (`frontend/`): feature folders (`timesheet`, `approvals`, `projects`, `periods`, `reports`), one API client (`src/api/client.ts`) with central 401 handling, `useAsync`/`useMutation` for the four standard states, role-aware navigation. The UI is **never** a security boundary.
- **Backend** (`backend/`): `routes → controllers → services → Prisma`. Middleware: Origin check, NUL rejection, authentication, role gates, Zod validation, central error handler. Services hold every business rule and transaction.
- **Database**: 9 tables, hand-written migrations for CHECK constraints and two triggers. Calendar dates are `DATE` (never time-zone converted, ADR 0006); hours are `numeric(4,2)`; ids are UUIDs; foreign keys are `RESTRICT`.

## Request path (a write)
`NUL check → cookies parsed → Origin check (state-changing requests) → access cookie (JWT + live session check) → role gate → Zod validation → service` (ownership/relationship check scoped in the query → **per-user advisory lock** → rules: week frozen? daily limit? project active? → **per-month advisory lock + period-lock check** → write → audit row in the same transaction) `→ DB trigger re-checks the lock → JSON response`.

## The central problem: period locking and integrity
A locked month must be immutable through every write path, including an edit racing the lock.
- **Layer 1 (service):** `assertDatesUnlocked` under a *shared* per-month advisory lock → 409 `PERIOD_LOCKED` (`enforcedBy: "service"`).
- **Layer 2 (database trigger):** `time_entries_period_lock` checks old and new month for INSERT/UPDATE/DELETE under the same advisory lock, so raw SQL is refused too (SQLSTATE `LK001`).
- **Race safety:** lock/unlock take the per-month lock *exclusively*: they wait for in-flight edits and block new ones until the lock row commits (a plain "check then write" would miss an uncommitted lock under READ COMMITTED). Proven by deterministic and randomized race tests.
- **Honest limit:** the table-owner role can disable triggers. The Docker setup uses a separate non-owner application role to close this (written, not yet run; `deployment.md`).
- Related guarantees: per-user advisory lock serializes a user's writes (daily-limit race); status-guarded updates make double decisions impossible; the audit table is append-only (trigger) and written in the same transaction as the action.

## Security layers
HttpOnly cookie tokens (ADR 0015 design, ADR 0019 transport): 15-minute JWT access token re-checked against its server-side session on every request, plus a single-use rotating refresh token stored only as a SHA-256 hash with an absolute expiry · argon2id · uniform login errors · failed-login and all-attempt throttling · `SameSite=Lax` + Origin allow-list against CSRF · scope filters in the query on every route (IDOR-safe 404s) · parameterized SQL only · `no-store` responses · strict CSP and security headers at nginx · tokens only in HttpOnly cookies (invisible to JavaScript, never in web storage). Reviewed independently in Phases 6 and 9 (`security.md`).

## Reports
Hours by contributor / project / month (any combination) and the project budget report are single SQL aggregations scoped by role; indexes were chosen from `EXPLAIN` on 600 k rows (ADR 0007).

## Where to read more
Decisions: `docs/decisions/` (0001-0013). API contracts: `api-contracts.md`. Schema: `database-design.md`. Security: `security.md`. Tests: `testing-strategy.md`. Operations: `deployment.md`. Demo: `walkthrough.md`. Limits: `known-limitations.md`.
