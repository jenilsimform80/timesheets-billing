# Known limitations, assumptions and open decisions

Honest list as of the end of Phase 9. Nothing here is hidden behind a passing test: each item is either a conscious scope/design choice, an unverified assumption, or a deployment responsibility.

## 1. Requirements are unverified
- `docs/requirements.md` is **"Derived from prompt — original specification unverified."** The original specification was never provided. Every rule below marked *assumption* has not been checked against it (POC-DOC-001 is still Blocked).
- Assumptions adopted so work could proceed: quarter-hour entries, 24 h/day hard cap, warnings above 10 h/day and 48 h/week; ISO (Monday) weeks; submitted/approved weeks frozen, rejected weeks reopen, no "recall"; a week needs ≥ 1 entry and an *active manager with role MANAGER* to be submitted; only the owner's direct manager approves (admins cannot); global calendar-month locks, admin-only unlock with a reason, admins not exempt; reports count all logged hours (not only approved); budget report admin-only with WARNING ≥ 80 % / OVER > 100 %; allocated hours hidden from non-admins; calendar dates never converted between time zones, years 2000–2100.

## 2. Product scope not built
- No self-service "forgot password" (email reset links, see ADR 0017 for why), no registration and no MFA. Admins reset other users' passwords; a forgotten admin password is recovered with `npm run admin:reset-password` on the server. (Users are created by admins, or by `npm run db:seed` in dev.)
- Previously: no user administration, password reset, registration or MFA (demo users come from `npm run db:seed`, dev only).
- No audit-trail screen (API exists, admin-only); admin changes to projects (budget/archive/dates) are **not audited**.
- A top-level manager (no manager of their own) cannot submit a timesheet (nobody could approve it).
- No notifications, report export, charts, saved filters, pagination (lists are capped: entries 1000, submissions 200, reports 5000 rows with a `truncated` flag).
- Locks are per global calendar month only (no per-project or arbitrary ranges); entries that exist when a lock is placed are not re-validated; locking a month with pending submissions is allowed; rejecting a week that touches a locked month is refused.

## 3. Delivery (Phase 10)
- **The Docker artifacts (`docker-compose.yml`, both Dockerfiles, `frontend/nginx/`, `docker/postgres/init/01-roles.sh`) were never executed**: there is no container runtime on the development machine. `docker compose up` is therefore **unverified**. Verified instead: fresh-database migration, the production runtime install and production-mode backend, the full e2e suite and the scripted walkthrough behind a proxy emulator using the real header values, and a clean-copy local setup. The two-role database setup (which closes the trigger-bypass limitation below in the Docker deployment) is written but its SQL has not been run.
- Tokens are HttpOnly cookies (ADR 0019): JavaScript cannot read them, but an XSS can still act from the victim's open tab. Cookies are shared by all tabs of a browser profile, so **only one user can be signed in per profile** (use separate profiles or a private window to try several roles). In production the cookies are `Secure`: Chrome and Firefox accept them on `http://localhost`, **Safari and non-localhost plain HTTP do not**, so the Docker demo needs one of those browsers or HTTPS in front of the `web` container (needed for a real deployment anyway). Refresh-token reuse is rejected but does not revoke the whole session (no token families).
- No TLS termination, backups schedule, monitoring or log shipping are provided.

## 4. Security posture and deployment responsibilities
- The backend is the only security boundary; the UI mirrors permissions for convenience.
- **In the non-Docker development setup the table-owner database role can bypass the DB triggers** (`ALTER TABLE … DISABLE TRIGGER`, `TRUNCATE`; verified). The Docker deployment uses separate owner/migration and least-privilege application roles to close this (written, unexecuted).
- Login throttling is in-memory per IP (resets on restart, not shared across instances). Behind a proxy set `TRUST_PROXY` to the exact hop count (never `true`). Add proxy-level rate limiting for the whole API.
- No background cleanup of expired sessions; absolute (not sliding) session expiry; no "sign out everywhere".
- Requests without an `Origin` header are accepted (not a browser CSRF vector).
- Source maps are emitted in production builds (timesheets-billing).
- **Production must configure** (see `docs/security.md`): `NODE_ENV=production`, TLS + HSTS at the proxy, SPA and `/api` on one origin, exact `FRONTEND_URL`, `TRUST_PROXY`, SPA response headers (CSP, nosniff, referrer policy) because the backend's helmet does not cover static files, no public `.map` files, a real environment instead of `--env-file=.env` in containers.

## 5. Performance
- Whole-table reports (admin, full range; lifetime budget) are O(rows): ≈ 0.5 s at 600 k entries (synthetic, one machine). No new index was justified by `EXPLAIN` (ADR 0007).

## 6. Testing limits
- End-to-end tests need Google Chrome (`channel: 'chrome'`) or `npx playwright install chromium`; they run on one browser engine, one viewport, and Linux only.
- The e2e config uses `127.0.0.1` (Playwright request-client delay with `localhost`, ADR 0010); real users must open `http://localhost:5173` in development.
- Concurrency tests are deterministic and randomized but cannot prove absence of races; the per-month and per-user advisory locks are reasoned about in ADR 0004/0005.
- The Phase 0 skills and slash commands were written to the supported format but never exercised in this session.
