#!/usr/bin/env bash
# Runnable walkthrough: demonstrates the six required scenarios against a RUNNING stack through the
# public HTTP API and ASSERTS every expected outcome (exits non-zero on the first mismatch).
#
#   BASE_URL=http://localhost:8080 DEMO_PASSWORD='<the demo seed password>' scripts/walkthrough.sh
#
# Needs: bash, curl, jq, GNU date, and the demo users (docs/deployment.md "Demo data").
# It writes data (one project, a few entries, one locked month in the far future); use a demo database.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8080}"
PASSWORD="${DEMO_PASSWORD:?set DEMO_PASSWORD to the password used when seeding the demo users}"
command -v jq >/dev/null || { echo "jq is required"; exit 2; }

# A unique far-future Monday and project code per run, so reruns never collide.
OFFSET=$(( ($(date +%s) / 604800) % 700 ))
WEEK=$(date -d "2040-01-02 + $((OFFSET * 7)) days" +%F)          # always a Monday
# Every demo day must fall in ONE calendar month (the lock is per month): slide forward if needed.
# Week A (steps 1-2) is submitted and approved; week B (step 3) stays open, so the period lock is the
# ONLY rule that can refuse a write there.
while [[ "$(date -d "$WEEK + 9 day" +%Y-%m)" != "${WEEK:0:7}" ]]; do WEEK=$(date -d "$WEEK + 7 days" +%F); done
D0=$WEEK; D1=$(date -d "$WEEK + 1 day" +%F)
D3=$(date -d "$WEEK + 8 day" +%F)                                  # a Tuesday of the NEXT week (week B)
MONTH=${WEEK:0:7}
MONTH_END=$(date -d "$MONTH-01 + 1 month - 1 day" +%F)
CODE="WALK-$(date +%s)"

DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT
FAILED=0
say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }
pass() { printf '   \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '   \033[31m✗ %s\033[0m\n' "$*"; FAILED=1; }

# call ROLE METHOD PATH [JSON] [EXTRA_HEADER]  ->  sets STATUS and BODY. Each role has its own cookie
# jar (like a separate browser profile): login stores the HttpOnly token cookies there and curl sends
# them back on later calls. An empty ROLE is an anonymous caller (an always-empty jar).
call() {
  local role=${1:-anon} method=$2 path=$3 data=${4:-} extra=${5:-}
  local jar="$DIR/$role.jar"
  local args=(-s -o "$DIR/body" -w '%{http_code}' -X "$method" "$BASE_URL$path" -H 'Accept: application/json')
  [[ "$role" == anon ]] && : > "$jar" || args+=(-c "$jar")
  args+=(-b "$jar")
  [[ -n "$extra" ]] && args+=(-H "$extra")
  [[ -n "$data" ]] && args+=(-H 'Content-Type: application/json' -d "$data")
  STATUS=$(curl "${args[@]}"); BODY=$(cat "$DIR/body")
  return 0
}
# cookie_of ROLE REGEX  ->  "name<TAB>value" of the first cookie in the role's jar whose name matches
cookie_of() { awk -F'\t' -v re="$2" '$6 ~ re {print $6 "\t" $7; exit}' "$DIR/$1.jar"; }
expect() { # expect STATUS "what it proves"
  if [[ "$STATUS" == "$1" ]]; then pass "$2 (HTTP $STATUS)"; else fail "$2 - expected HTTP $1, got $STATUS: $BODY"; fi
}
expect_code() { # expect_code STATUS ERROR_CODE "what it proves"
  local got; got=$(jq -r '.error.code // empty' <<<"$BODY")
  if [[ "$STATUS" == "$1" && "$got" == "$2" ]]; then pass "$3 (HTTP $STATUS $got)"; else fail "$3 - expected HTTP $1 $2, got $STATUS ${got:-?}: $BODY"; fi
}
login() { call "$1" POST /api/auth/login "{\"email\":\"$2\",\"password\":\"$PASSWORD\"}"; expect 200 "login as $2"; }

say "Setup: sign in as the demo users (contributor, manager, other manager, admin)"
login dev     dev1@example.com
login mgr     manager@example.com
login other   other.manager@example.com
login admin   admin@example.com

call admin POST /api/projects "{\"code\":\"$CODE\",\"name\":\"Walkthrough project\",\"budgetHours\":10}"; expect 201 "admin creates project $CODE"
PROJECT=$(jq -r .project.id <<<"$BODY")
call admin POST "/api/projects/$PROJECT/tasks" '{"name":"Build"}'; expect 201 "admin adds a task"
TASK=$(jq -r .task.id <<<"$BODY")

# ---------------------------------------------------------------------------------------------------
say "1. Logging and submitting hours  (contributor, week of $WEEK)"
call dev POST /api/time-entries "{\"projectId\":\"$PROJECT\",\"taskId\":\"$TASK\",\"workDate\":\"$D0\",\"hours\":7.5,\"isBillable\":true,\"notes\":\"Kick-off\"}"; expect 201 "log 7.5 h billable on $D0"
E0=$(jq -r .entry.id <<<"$BODY")
call dev POST /api/time-entries "{\"projectId\":\"$PROJECT\",\"taskId\":\"$TASK\",\"workDate\":\"$D1\",\"hours\":2,\"isBillable\":false}"; expect 201 "log 2 h non-billable on $D1"
call dev POST /api/time-entries "{\"projectId\":\"$PROJECT\",\"taskId\":\"$TASK\",\"workDate\":\"$D0\",\"hours\":17,\"isBillable\":true}"; expect_code 422 DAILY_LIMIT_EXCEEDED "a 24 h/day total is refused (7.5 + 17)"
call dev GET "/api/timesheets/$WEEK"; expect 200 "week summary"
note "week total $(jq -r .weeklyTotal <<<"$BODY") h = $(jq -r .billableTotal <<<"$BODY") billable + $(jq -r .nonBillableTotal <<<"$BODY") non-billable, status $(jq -r .status <<<"$BODY")"
[[ $(jq -r .weeklyTotal <<<"$BODY") == "9.5" ]] || fail "weekly total should be 9.5"
call dev POST /api/submissions "{\"weekStart\":\"$WEEK\"}"; expect 201 "submit the week"
SUB=$(jq -r .submission.id <<<"$BODY")
call dev PATCH "/api/time-entries/$E0" '{"hours":1}'; expect_code 409 WEEK_NOT_EDITABLE "a submitted week is frozen"

# ---------------------------------------------------------------------------------------------------
say "2. Manager approval and rejection  (only the owner's direct manager)"
call mgr GET "/api/submissions?forApproval=true"; expect 200 "manager's queue"
[[ $(jq -r "[.submissions[] | select(.id==\"$SUB\")] | length" <<<"$BODY") == 1 ]] && pass "the submission is in the manager's queue" || fail "submission not in queue"
call mgr POST "/api/submissions/$SUB/reject" '{}'; expect 400 "rejecting without a reason is refused"
call mgr POST "/api/submissions/$SUB/reject" '{"comment":"Please add Wednesday"}'; expect 200 "manager rejects with a reason"
call dev PATCH "/api/time-entries/$E0" '{"hours":8}'; expect 200 "the rejected week is editable again"
call dev POST /api/submissions "{\"weekStart\":\"$WEEK\"}"; expect 201 "contributor resubmits"
call mgr POST "/api/submissions/$SUB/approve" '{"comment":"Thanks"}'; expect 200 "manager approves"
call mgr POST "/api/submissions/$SUB/approve" '{}'; expect_code 409 INVALID_STATE "a second decision is refused"
call dev GET "/api/submissions/$SUB"; note "decision history: $(jq -c '[.submission.approvals[] | {decision, comment}]' <<<"$BODY")"

# ---------------------------------------------------------------------------------------------------
say "3. Locked-period write rejection through DIRECT API requests  (no UI involved)"
call dev POST /api/time-entries "{\"projectId\":\"$PROJECT\",\"taskId\":\"$TASK\",\"workDate\":\"$D3\",\"hours\":1,\"isBillable\":true}"; expect 201 "before the lock: an entry in the open week of $MONTH ($D3) is accepted"
E2=$(jq -r .entry.id <<<"$BODY")
call admin POST /api/locked-periods "{\"period\":\"$MONTH\",\"note\":\"walkthrough\"}"; expect 201 "admin locks $MONTH"
call dev POST /api/time-entries "{\"projectId\":\"$PROJECT\",\"taskId\":\"$TASK\",\"workDate\":\"$D3\",\"hours\":1,\"isBillable\":true}"; expect_code 409 PERIOD_LOCKED "CREATE in the locked month is refused"
call dev PATCH "/api/time-entries/$E2" '{"hours":3}';  expect_code 409 PERIOD_LOCKED "UPDATE in the locked month is refused"
call dev DELETE "/api/time-entries/$E2";                expect_code 409 PERIOD_LOCKED "DELETE in the locked month is refused"
note "error details: $(jq -c .error.details <<<"$BODY")"
call admin POST /api/time-entries "{\"projectId\":\"$PROJECT\",\"taskId\":\"$TASK\",\"workDate\":\"$D3\",\"hours\":1,\"isBillable\":true}"; expect_code 409 PERIOD_LOCKED "admins are not exempt"
note "(the database trigger enforces the same rule for writes that bypass the API: see docs/walkthrough.md, step 3b)"

# ---------------------------------------------------------------------------------------------------
say "4. Authorization failures"
call "" GET /api/projects; expect_code 401 UNAUTHENTICATED "anonymous request"
call other GET "/api/time-entries/$E2"; expect 404 "another team's manager cannot even see the entry"
call dev POST "/api/submissions/$SUB/approve" '{}'; expect 403 "a contributor cannot approve"
call admin POST "/api/submissions/$SUB/approve" '{}'; expect 404 "an admin cannot approve while the owner has an active manager (ADR 0016: admins are only the fallback)"
call other POST "/api/submissions/$SUB/approve" '{}'; expect 404 "a manager outside the reporting line gets 404, not 'forbidden' (no probing)"
call dev GET /api/audit-logs; expect 403 "audit trail is admin-only"
call dev GET /api/reports/project-budgets; expect 403 "budget report is admin-only"
call dev POST /api/locked-periods '{"period":"2041-01"}'; expect 403 "a contributor cannot lock a period"
call dev POST /api/time-entries '{}' 'Origin: https://evil.example'; expect_code 403 FORBIDDEN "a forged cross-site write is refused even though the browser would attach the valid cookies (Origin check)"
OLD_REFRESH=$(cookie_of dev '^(__Secure-)?rt$')
call dev POST /api/auth/refresh; expect 200 "refresh rotates the refresh cookie and sets a new access cookie"
call anon POST /api/auth/refresh '' "Cookie: ${OLD_REFRESH/$'\t'/=}"; expect_code 401 UNAUTHENTICATED "the refresh token that was just exchanged cannot be used again (rotation)"
call dev GET "/api/users"; note "a contributor sees only themself: $(jq -c '[.users[].email]' <<<"$BODY")"

# ---------------------------------------------------------------------------------------------------
say "5. Reporting and aggregation  (computed by PostgreSQL, scoped by role)"
call admin GET "/api/reports/hours?from=$MONTH-01&to=$MONTH_END&groupBy=month"; expect 200 "hours by month (admin)"
note "$(jq -c '.rows[0]' <<<"$BODY")"
call admin GET "/api/reports/hours?from=$MONTH-01&to=$MONTH_END&groupBy=contributor,project"; expect 200 "hours by contributor and project"
echo "$BODY" | jq -r --arg c "$CODE" '.rows[] | select(.projectCode==$c) | "   \(.userName) / \(.projectCode): \(.totalHours) h (\(.billableHours) billable, \(.nonBillableHours) non-billable)"'
TOTAL=$(jq -r --arg c "$CODE" '[.rows[] | select(.projectCode==$c) | .totalHours] | add' <<<"$BODY")
[[ "$TOTAL" == "11" ]] && pass "totals add up: 8 h (corrected) + 2 h + 1 h = 11 h" || fail "expected 11 h for the project, got $TOTAL"
call admin GET "/api/reports/project-budgets"; expect 200 "budget report"
echo "$BODY" | jq -r --arg c "$CODE" '.projects[] | select(.code==$c) | "   \(.code): \(.loggedHours) of \(.budgetHours) h used (\(.percentUsed)%), status \(.status)"'
[[ $(jq -r --arg c "$CODE" '.projects[] | select(.code==$c) | .status' <<<"$BODY") == "OVER" ]] && pass "11 h against a 10 h budget is flagged OVER" || fail "budget status should be OVER"
call dev GET "/api/reports/hours?from=$MONTH-01&to=$MONTH_END&groupBy=contributor"; expect 200 "a contributor can run reports, but only over their own hours"
note "rows visible to the contributor: $(jq -c '[.rows[].userName]' <<<"$BODY")"

# ---------------------------------------------------------------------------------------------------
say "6. Audit-trail evidence"
call admin GET "/api/audit-logs?limit=200"; expect 200 "admin reads the audit trail"
echo "$BODY" | jq -r --arg w "$WEEK" --arg m "$MONTH" '.auditLogs[] | select((.metadata.weekStart // "") == $w or (.metadata.period // "") == $m) | "   \(.createdAt)  \(.action)  by \(.actor.name)  \(.metadata | tojson)"' | sort | head -12
COUNT=$(jq -r --arg w "$WEEK" --arg m "$MONTH" '[.auditLogs[] | select((.metadata.weekStart // "") == $w or (.metadata.period // "") == $m)] | length' <<<"$BODY")
[[ "$COUNT" -ge 5 ]] && pass "submit, reject, resubmit, approve and lock are all recorded ($COUNT records)" || fail "expected >= 5 audit records, got $COUNT"
call admin POST "/api/locked-periods/$MONTH/unlock" '{"reason":"walkthrough cleanup"}'; expect 204 "unlock (reason is mandatory and audited)"
call admin GET "/api/audit-logs?action=PERIOD_UNLOCKED&limit=1"; note "latest unlock record: $(jq -c '.auditLogs[0] | {action, reason: .metadata.reason, by: .actor.name}' <<<"$BODY")"

echo
if [[ $FAILED -eq 0 ]]; then printf '\033[32mWalkthrough complete: every expected outcome was observed.\033[0m\n'; else printf '\033[31mWalkthrough FAILED: see ✗ lines above.\033[0m\n'; exit 1; fi
