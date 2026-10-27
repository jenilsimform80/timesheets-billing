# Setup, deployment and operations

Two ways to run the system. **Verification status is stated per path** - read it before relying on a command.

| Path | Use it for | Verification status |
|------|-----------|---------------------|
| **A. Docker Compose** (`docker compose up`) | A self-contained deployment: PostgreSQL + backend + nginx-served frontend | **Verified on Docker Engine 29.9 / Compose 5.6 (2026-10-14):** `docker compose up --build` from a fresh `.env` starts all services healthy; `/api/health` returns `{"status":"ok","database":"up"}` through nginx on :8080; the SPA and the CSP headers are served; the app role is refused `ALTER TABLE ... DISABLE TRIGGER` and `TRUNCATE`. Two bugs found by this first real run and fixed: the optional `seed` service made `docker compose up` fail without `SEED_PASSWORD`, and the backend image crashed because `prisma generate` ran before `tsconfig.json` was copied. **Not yet run in Docker:** the browser e2e suite and `scripts/walkthrough.sh` against this stack, and the `audit_logs` DELETE check on a non-empty table. |
| **B. Local development** (no Docker) | Day-to-day development with your own PostgreSQL | **Verified** from a clean copy of the repository, following exactly the steps below (see "Fresh-setup verification"). |

## Architecture at a glance
```
 Browser ──HTTP(S)──► web (nginx, :8080) ──/api/*──► backend (Express, :3000, internal) ──► db (PostgreSQL, internal)
                       │  serves the SPA                 │ runs as role timesheets_app             ▲
                       │  adds CSP + security headers    │ (data access only)                       │ migrate (one-shot) runs as
                       └─ overwrites X-Forwarded-For     └─ TRUST_PROXY=1                            └─ role timesheets_owner
```
Only `web` publishes a port. The database and the API are reachable only on the internal Compose network.

## A. Docker Compose
Prerequisites: Docker Engine with the Compose plugin (v2), ~2 GB disk.

1. Configure (once):
   ```bash
   cp .env.example .env
   # Replace every CHANGE_ME with a long random value, e.g.:  openssl rand -hex 24
   ```
   | Variable | Meaning |
   |----------|---------|
   | `POSTGRES_SUPERUSER_PASSWORD` | PostgreSQL superuser inside the container (used once, to create the roles) |
   | `DB_NAME` | database name (default `timesheets`) |
   | `DB_OWNER_PASSWORD` | role that owns the schema; used **only** by the one-shot `migrate` service |
   | `DB_APP_PASSWORD` | role the running backend uses: `SELECT/INSERT/UPDATE/DELETE` only |
   | `PUBLIC_ORIGIN` | the exact URL users open (default `http://localhost:8080`); becomes the backend `FRONTEND_URL` |
   | `WEB_PORT` | host port for the web container (default 8080) |
   | `JWT_SECRET` | **required**: signs access tokens, at least 32 characters (`openssl rand -base64 48`) |
   | `ACCESS_TOKEN_TTL_MINUTES` | access token lifetime (default 15) |
   | `SESSION_TTL_HOURS` | absolute login lifetime = refresh-token lifetime (default 8) |
   | `SEED_PASSWORD` | only for demo data (below) |
   Use alphanumeric passwords (they are embedded in connection URLs). `.env` is git-ignored; never commit it. Compose refuses to start while a required variable is missing.
2. Start: `docker compose up --build`  →  open **http://localhost:8080**.
   Startup order is enforced: `db` (healthy) → `migrate` (applies the committed Prisma migrations, exits) → `backend` (healthy) → `web`.
3. Demo data (optional, **never for a real deployment**): `SEED_PASSWORD='<8+ chars>' docker compose --profile demo run --rm seed` creates `admin@`, `manager@`, `other.manager@`, `dev1@`, `dev2@example.com` with that password. The seed script refuses to run as production, so the one-shot `seed` service sets `NODE_ENV=development` for itself only.
4. Operate:
   | Task | Command |
   |------|---------|
   | Logs | `docker compose logs -f backend` |
   | Stop (keep data) | `docker compose down` |
   | Stop and **delete the database** | `docker compose down -v` |
   | Backup | `docker compose exec db pg_dump -U postgres timesheets > backup.sql` |
   | Apply new migrations after an upgrade | `docker compose up --build` (the `migrate` service runs `prisma migrate deploy` every start; it is idempotent) |

### HTTPS
Authentication uses `Secure`, HttpOnly cookies in production (ADR 0019). Chrome and Firefox accept them on `http://localhost`, so the local demo works there; **Safari and any plain-HTTP non-localhost address will not keep the session**. A real deployment needs HTTPS anyway (cookies and credentials travel in headers): put a TLS-terminating proxy (or an ingress) in front of the `web` container, keep the app and `/api` on one origin, and set `PUBLIC_ORIGIN` to the public `https://…` URL. The nginx config overwrites `X-Forwarded-For` with the address it sees; if another proxy sits in front, set `TRUST_PROXY` in `docker-compose.yml` to the real number of hops.

### Two database roles (closes a documented limitation)
`docker/postgres/init/01-roles.sh` runs once, on first volume creation: it creates `timesheets_owner` (owns the schema, used by `migrate`) and `timesheets_app` (used by the backend) with default privileges `SELECT, INSERT, UPDATE, DELETE` only. Because the app role is **not the table owner** and has no `TRUNCATE`, it cannot `ALTER` tables, `DISABLE TRIGGER` (the period-lock and audit append-only guards) or `TRUNCATE`. Check it after the first start (expected results in comments; the first two were executed on a real Docker stack):
```bash
docker compose exec db psql -U timesheets_app -d timesheets -c "ALTER TABLE time_entries DISABLE TRIGGER time_entries_period_lock;"   # ERROR: must be owner of table time_entries
docker compose exec db psql -U timesheets_app -d timesheets -c "TRUNCATE time_entries;"                                              # ERROR: permission denied for table time_entries
docker compose exec db psql -U timesheets_app -d timesheets -c "DELETE FROM audit_logs;"                                             # ERROR: AUDIT_APPEND_ONLY (trigger)
```
The init script only runs when the volume is empty; to change roles/passwords later use `docker compose down -v` (deletes data) or `ALTER ROLE` manually.

### What was verified instead of `docker compose up`
Without Docker the following were run for real and passed (details in `.claude/tasks/phase-status.md`): (1) `prisma migrate deploy` on an **empty** database (9 tables, 2 triggers, 6 CHECK constraints); (2) the backend built and started from **only** `dist/` + `npm ci --omit=dev --omit=optional` (91 MB, no dev tools, no `.env`) in `NODE_ENV=production`; (3) the **entire Playwright suite (30 tests) against that production-mode backend behind a proxy emulator that applies the exact header values parsed from `frontend/nginx/security-headers.conf`** (strict CSP with zero violations, Secure `__Host-sid` cookie, source maps 404, `X-Forwarded-For` overwritten, `TRUST_PROXY=1`); (4) `scripts/walkthrough.sh` against the same stack. **Not verified:** that the Dockerfiles build, that `docker-compose.yml` is semantically valid (it parses as YAML), that nginx accepts `default.conf`, and the role-separation SQL (creating roles needs a superuser that was not available). Run `docker compose config` and `docker compose up --build` once Docker is available and treat any failure as a bug in those files.

## B. Local development (no Docker)
Prerequisites: Node.js ≥ 22.12, npm, PostgreSQL 14+ (a local server you can create roles in).

1. **Database** (once; run as a PostgreSQL superuser, e.g. `sudo -u postgres psql`):
   ```sql
   CREATE ROLE timesheets WITH LOGIN PASSWORD '<choose>' CREATEDB;
   CREATE DATABASE timesheets_dev  OWNER timesheets;
   ```
2. **Backend**
   ```bash
   cd backend
   cp .env.example .env     # set DATABASE_URL (replace CHANGE_ME); NODE_ENV=development stays
   npm ci
   npx prisma migrate deploy        # apply the committed migrations to the database
   SEED_PASSWORD='<8+ chars>' npm run db:seed                 # demo users (dev only)
   npm run dev                                                 # API on :3000
   ```
3. **Frontend** (second terminal)
   ```bash
   cd frontend && npm ci && npm run dev    # open http://localhost:5173 (use "localhost", not 127.0.0.1)
   ```
4. Sign in with e.g. `dev1@example.com` / the seed password. Details: `backend/README.md`, `frontend/README.md`.

## Migrations
Prisma migrations in `backend/prisma/migrations/` are the single source of schema (including hand-written triggers/constraints). Rules: never edit an applied migration (add a new one); review generated SQL; `prisma migrate deploy` applies pending migrations non-interactively (use it in setup and CI); `prisma migrate dev` is for creating new migrations during development; never run `migrate reset` against data you care about.

## Test commands
| What | Command | Needs |
|------|---------|-------|
| Backend: type-check, lint, format, 285 tests | `cd backend && npm run check` | `DATABASE_URL` (tests use the derived `_test` database) |
| Frontend: type-check, lint, format, 186 tests | `cd frontend && npm run check` | nothing external |
| End-to-end (30 browser tests) | `cd frontend && npm run e2e` | Google Chrome, free ports 3000/5173, `DATABASE_URL` (uses the derived `_test` database) |
| End-to-end against a running (e.g. production-like) stack | `E2E_EXTERNAL_SERVERS=1 E2E_BASE_URL=… E2E_EXPECT_CSP=1 npm run e2e` | the stack + the derived `_test` database |
| Live API contract check | `cd frontend && LIVE_PASSWORD=… npm run test:live` | a running backend on a disposable DB |
| Scripted walkthrough | `BASE_URL=… DEMO_PASSWORD=… scripts/walkthrough.sh` | a running stack with demo users |

## Secrets
Nothing secret is committed: `.env` files are git-ignored, `.env.example` files contain placeholders, the seed password comes from the environment, and e2e passwords are random per run. Rotate by changing `.env` and recreating the containers (database role passwords: see the init-script note above).

## Production checklist
See `docs/security.md` (Phase 9) - TLS and HSTS, same origin, exact `FRONTEND_URL`, `TRUST_PROXY`, SPA headers (provided by `frontend/nginx/`), proxy-level rate limiting, session cleanup job, backups.
