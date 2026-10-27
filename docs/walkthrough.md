# Timesheets and Project Billing walkthrough

About 15 minutes. It demonstrates the six required scenarios, first by **script** (fast, asserts every outcome) and then by **UI** (what a reviewer clicks). Prerequisite: a running stack with the demo users (`docs/deployment.md`).

## Fastest: the scripted walkthrough
```bash
BASE_URL=http://localhost:8080 DEMO_PASSWORD='<demo seed password>' scripts/walkthrough.sh
```
(Dev servers: `BASE_URL=http://localhost:5173`.) The script signs in as four roles and exercises everything below through the public HTTP API, **asserting each expected status/code**; it prints evidence and exits non-zero on the first surprise. It was run for real against the production-mode backend behind the header-faithful proxy: every outcome observed (last run: totals 11 h = 9 billable + 2 non-billable, budget 110 % → `OVER`, five audit records).

## Manual walkthrough in the browser
Open the app (`http://localhost:8080` with Docker, `http://localhost:5173` in development; use `localhost`). Demo users share the seed password: `admin@`, `manager@`, `other.manager@`, `dev1@`, `dev2@example.com`.

**Setup (admin):** sign in as `admin@example.com` → *Projects* → *New project* (code `DEMO-1`, budget `10`) → add a task `Build`. Sign out.

### 1. Logging and submitting hours
Sign in as `dev1@example.com` → *Timesheet* → pick a week → on a day press *+ Add entry* → project `DEMO-1`, task `Build`, 7.5 h. Add 2 h *non-billable* on another day. Try a third entry that pushes one day over 24 h: the form shows *"exceeding the 24-hour daily limit"*. Press *Submit week for approval* → confirm. **Expected:** status *Submitted*, all edit buttons gone ("This week is submitted and cannot be edited"), the week appears in *Submission history*.

### 2. Manager approval and rejection
Sign in as `manager@example.com` → *Approvals* → *Review Casey Contributor*. Press *Reject* with an empty comment → refused ("Explain what needs to change"). Enter a reason → *Reject*. Sign in again as `dev1@example.com`: the week shows the rejection reason and is editable; add an entry and *Resubmit*. As the manager *Approve* it. **Expected:** decision history lists *Rejected* then *Approved*; a second decision is impossible ("Already decided"). `other.manager@example.com` cannot see this submission at all.

### 3. Locked-period write rejection through direct API requests
Sign in as `admin@example.com` → *Locked periods* → lock the month of the entries. As `dev1@example.com` the timesheet now shows "This month is locked for billing" and no edit buttons. **Direct API proof** (the UI is not the boundary): in the browser's developer console, while signed in as `dev1` (the HttpOnly cookies are attached automatically; if the API origin differs from the page's, use its full URL, which the `credentials: 'include'` below makes work):
```js
fetch('/api/time-entries', {method: 'POST', credentials: 'include', headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({projectId: '<id>', taskId: '<id>', workDate: '<a day in the locked month>', hours: 1, isBillable: true})})
  .then(r => r.json().then(b => console.log(r.status, b)))
```
**Expected:** `409 {"error":{"code":"PERIOD_LOCKED","details":{"period":"2043-02","enforcedBy":"service"}}}`. PATCH and DELETE of an existing entry, and moving an entry into or out of the month, are refused the same way; admins are not exempt. `scripts/walkthrough.sh` does all of this with curl.

**3b. Database layer (writes that bypass the application)** - with the Docker stack, as the application role:
```bash
docker compose exec db psql -U timesheets_app -d timesheets \
  -c "UPDATE time_entries SET hours = 1 WHERE work_date >= '<first day of the locked month>' AND work_date < '<first day of next month>';"
```
**Expected:** `ERROR: PERIOD_LOCKED: period 2043-02 is locked` (SQLSTATE `LK001`, raised by the trigger). Also `TRUNCATE time_entries;` → *permission denied*, and `ALTER TABLE time_entries DISABLE TRIGGER time_entries_period_lock;` → *must be owner*. (**Not yet executed on Docker.** In the non-Docker development setup the application role *owns* the tables and could disable triggers: the two-role setup in Compose exists to close that.)
Then *Locked periods* → *Unlock* with a reason (3+ characters is mandatory) → `dev1` can edit again.

### 4. Authorization failures
In the browser: `manager@` opening `/periods` or `/reports/budgets` → "You don't have access to this page"; `dev1@` opening `/approvals` likewise (and no *Budget* row on *Projects*: allocated hours are admin-only). Direct API (also scripted): anonymous → `401`; contributor reading another contributor's entry id → `404` (not `403`: ids cannot be probed); contributor approving → `403`; an admin while the owner has an active manager, or a manager outside the reporting line → `404`; contributor calling `/api/audit-logs`, `/api/reports/project-budgets` or locking a period → `403`; a forged write with a foreign `Origin` header, even with valid cookies → `403` (Origin check); a used refresh token cannot be used again.

### 5. Reporting and aggregation
As `admin@`: *Reports* → From/To covering the demo month → group by *Contributor* + *Project* → *Run report*: total/billable/non-billable hours and entry counts, with a totals row. *Budgets*: `DEMO-1` shows hours logged against the 10 h budget, `%` used and a status (*On track* below 80 %, *Nearly used* from 80 %, *Over budget* above 100 %). As `dev1@` the report only ever contains their own hours. All numbers are computed by PostgreSQL aggregation, not in the browser; the end-to-end suite checks the same figures from four browser time zones.

### 6. Audit-trail evidence
As admin: `GET /api/audit-logs` (browser address bar while signed in, or the script): one record each for *submitted*, *rejected*, *resubmitted*, *approved*, *period locked* and *period unlocked* (with the reason), each with actor, entity and metadata (e.g. the lock records how many entries/hours were frozen). The records are written in the same database transaction as the action and the table is append-only (`UPDATE`/`DELETE` raise `AUDIT_APPEND_ONLY`); a refused action writes nothing.

## What to say about limits
Be upfront that: requirements were derived from the brief (the original spec was never provided); several policies are documented assumptions; the Docker artifacts have not been run; and the items in `docs/known-limitations.md` remain.
