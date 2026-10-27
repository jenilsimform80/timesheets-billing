# Frontend

React 19 + TypeScript (strict) + Vite 8 + React Router 7. Phase 7 built the foundation (routing, central API client, standard states, status page); Phase 8 added the feature screens below, all talking to the real backend API. Design decisions: [ADR 0008](../docs/decisions/0008-frontend-foundation.md) (foundation) and [ADR 0009](../docs/decisions/0009-frontend-features.md) (features).

## Screens

| Route                          | Who sees it                       | What it does                                                                                                                                        |
| ------------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`                       | everyone                          | Sign in; returns you to the page you wanted. Any later 401 sends you back here                                                                      |
| `/`                            | signed in                         | Welcome + role-appropriate links                                                                                                                    |
| `/timesheet?week=YYYY-MM-DD`   | all roles                         | Week view: add / edit / delete entries per day, totals, backend warnings, submit the week (with confirmation), rejection reason, submission history |
| `/approvals`, `/approvals/:id` | managers                          | Queue of your team's weeks; review a week read-only; approve (optional comment) or reject (reason required)                                         |
| `/projects`                    | all roles read; admins manage     | Projects and tasks; admins create, edit, archive/restore, add/rename/archive tasks                                                                  |
| `/reports`                     | all roles (scoped by the backend) | Hours by contributor / project / month in any combination, filters, totals                                                                          |
| `/reports/budgets`             | admins                            | Logged vs allocated hours per project with usage and status                                                                                         |
| `/periods`                     | admins                            | Lock a month; unlock with a mandatory reason                                                                                                        |
| `/status`                      | everyone                          | API and database health                                                                                                                             |

The navigation shows only what your role can use, **but that is a convenience**: the backend enforces every permission, period lock and workflow rule regardless of the UI.

## Requirements

Node.js >= 22.12, npm. The backend running (see `backend/README.md`).

## Setup

```bash
cd frontend
npm install
cp .env.example .env.local   # optional; defaults work with the backend on :3000
```

## Run it

```bash
# terminal 1 - backend (needs its database, see backend/README.md)
cd backend && npm run dev

# terminal 2 - frontend
cd frontend && npm run dev
```

Open **http://localhost:5173** (use `localhost`, **not** `127.0.0.1`: the backend only allows the origin `http://localhost:5173`, so anything else gets `403 Origin not allowed` on POST/PATCH/DELETE). Go to **System status**: API and database should show "Operational" / "Connected".

The browser calls the backend directly at `VITE_API_URL` (see `.env.example`). Authentication is two HttpOnly cookies set by the backend (ADR 0019): the app never sees or stores a token, and it asks `/auth/me` who is signed in, so **reloading keeps you signed in**. Because the frontend (`:5173`) and the API (`:3000`) must be **same-site**, open the app on `localhost` (the cookies are not sent between `localhost` and `127.0.0.1`). Cookies are shared by every tab of a browser profile: **one user per profile**, so use separate profiles or a private window to try several roles at once.

## Environment variables

| Name           | Default | Purpose                                                                                                                                                      |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_API_URL` | `/api`  | Base URL the browser uses for API calls, e.g. `http://localhost:3000/api`. The backend `FRONTEND_URL` must list this app's origin. Leave unset behind nginx. |

Only `VITE_*` variables are exposed to browser code; never put secrets in them.

## Commands

| Command                           | Purpose                                             |
| --------------------------------- | --------------------------------------------------- |
| `npm run dev`                     | Dev server on :5173 (fixed port)                    |
| `npm run build`                   | Type-check, then production build into `dist/`      |
| `npm run preview`                 | Serve `dist/` on :4173                              |
| `npm run typecheck`               | `tsc --noEmit`                                      |
| `npm run lint`                    | ESLint (type-aware, react-hooks, react-refresh)     |
| `npm run format` / `format:check` | Prettier write / check                              |
| `npm test`                        | Vitest + React Testing Library (jsdom) once         |
| `npm run check`                   | typecheck + lint + format:check + test              |

## Structure

```
src/
  api/          the only code that calls fetch: client.ts (+ central 401 handler), errors.ts (ApiError), types.ts, one wrapper module per backend area
  auth/         AuthProvider (session), RequireAuth / RequireRole guards, access.ts (role → area)
  config/       env parsing/validation
  features/     one folder per screen area: timesheet, approvals, projects, periods, reports
  hooks/        useAsync (stale-while-revalidate), combineAsync, useMutation
  lib/          dates.ts (calendar-date helpers), forms.ts (backend field errors), navigation.ts
  components/
    ui/         Button, Alert, Badge, FormControls, LoadingState, ErrorState, EmptyState, AsyncView (+ CSS modules)
    layout/     AppLayout (role-aware nav, account, skip link, <main>)
  pages/        shared route components (Home, Login, Status, NotFound, RouteError)
  routes/       the single route table (used by main.tsx and by tests)
  styles/       global.css (design tokens, light/dark, form/table base styles)
tests/          Vitest + RTL (setup.ts, helpers.tsx with the API mock, *.test.ts[x])
tests-live/     opt-in contract check against a real backend (see below)
```

## Conventions

- **Never call `fetch` directly**: add a typed wrapper under `src/api/` that uses `apiRequest`. Failures arrive as `ApiError` (`status`, backend `code`, `message`); cancellation is ignored.
- Data-backed views use `useAsync(load)` (with a stable `load`) and render through `AsyncView` so loading, error (with retry), empty and success are handled the same way everywhere.
- Show users `ApiError.message` or a generic message, never raw exception text.
- The UI is **not** a security boundary: hiding a button is a convenience; the backend enforces permissions and period locks.
- Styles: CSS Modules (`*.module.css`) and the CSS variables in `styles/global.css`.

## End-to-end tests

`npm run e2e` runs 29 Playwright tests in real Google Chrome. Playwright starts the backend and Vite itself; before each run `e2e/global-setup.ts` creates/migrates the derived `<name>_test` database (`npm run db:setup:test`), empties it (`npm run db:reset:test`, which **refuses any database whose name does not end in `_test`**) and seeds the demo users with a random password. It derives that name from `DATABASE_URL` in `backend/.env` (or `E2E_DATABASE_URL`) and needs ports 3000 and 5173 free. Specs: `workflow` (login → project → hours → submit → reject → resubmit → approve → report/budget), `locking` (UI plus direct API calls), `security` and `timezone-and-reports` (the same data viewed from four time zones). Without system Chrome run `npx playwright install chromium` and remove `channel: 'chrome'` from `playwright.config.ts`. The config uses `127.0.0.1` because Playwright's request client is ≈5 s slower per request on `localhost`; for normal use open `http://localhost:5173`.

## Live contract check (optional)

`npm test` stubs `fetch`. To verify the wrappers and response shapes against the real API, run the backend against a database you can afford to fill, seed the demo users, and run:

```bash
cd backend && SEED_PASSWORD='choose-8+-chars' npm run db:seed
cd backend && npm run dev        # API on :3000
cd frontend && LIVE_PASSWORD='choose-8+-chars' npm run test:live
```

It signs in as a contributor, a manager and an admin, and walks projects → entries → submit → reject → resubmit → approve → lock/unlock → reports/budgets, checking shapes and permission refusals. It writes data, so never point it at data you care about. Skipped automatically when `LIVE_PASSWORD` is not set.

## Testing

`tests/helpers.tsx` provides `mockApi({ 'GET /path': …, 'POST /path/:id': … })`: it stubs `fetch`, records every request, and **fails the test on any API call nobody mocked**. Tests render the real route table with an in-memory router and, for write flows, use small stateful fake backends so that create/edit/delete really change the next load. They cover the API client (incl. central 401), the hooks, dates, every screen (positive paths, validation, backend refusals, empty/error/retry states, role gating) and the status page.
