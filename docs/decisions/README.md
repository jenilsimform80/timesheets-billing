# Architecture Decision Records

One short file per significant decision: `NNNN-title.md`.

## Template
```
# NNNN. Title
Status: Proposed | Accepted | Superseded
Context: what forces the decision
Decision: what we chose
Alternatives: what else was considered
Consequences: trade-offs and follow-ups
```

## Index
| ID | Decision | Status |
|----|----------|--------|
| 0001 | [Pin TypeScript to 6.0.x](0001-typescript-version.md) | Accepted |
| 0002 | [Prisma 7 with pg adapter and dependency overrides](0002-prisma-7-and-dependency-overrides.md) | Accepted |
| 0003 | [Server-side cookie sessions with argon2id](0003-session-strategy.md) | Accepted (cookie part superseded by 0015) |
| 0004 | [Timesheet workflow rules and per-user write serialization](0004-timesheet-workflow-rules.md) | Accepted |
| 0005 | [Period locking: two layers + shared/exclusive advisory lock](0005-period-lock-enforcement.md) | Accepted |
| 0006 | [Time zone policy: calendar dates are never converted](0006-timezone-policy.md) | Accepted |
| 0007 | [Report queries and index decisions](0007-report-queries-and-indexes.md) | Accepted |
| 0008 | [Frontend foundation: stack, API access, pinned versions](0008-frontend-foundation.md) | Accepted |
| 0009 | [Frontend features: structure, state handling, UI-vs-backend](0009-frontend-features.md) | Accepted |
| 0010 | [Phase 9 hardening decisions and e2e approach](0010-phase-9-hardening-and-e2e.md) | Accepted |
| 0011 | [Delivery topology: Docker Compose, nginx, two database roles](0011-delivery-topology.md) | Accepted (Docker artifacts unexecuted) |
| 0012 | [Admin-only user administration](0012-admin-user-creation.md) | Accepted |
| 0013 | [OpenAPI document and Swagger UI](0013-openapi-swagger-ui.md) | Accepted |
| 0014 | [Restricted projects, task assignment and manager hierarchy](0014-project-access-and-task-assignment.md) | Accepted |
| 0015 | [Bearer-token authentication (JWT + rotating refresh token)](0015-bearer-token-authentication.md) | Accepted (supersedes cookie part of 0003; transport superseded by 0019) |
| 0016 | [Admin approves when the owner has no usable manager](0016-admin-approval-fallback.md) | Accepted (amends 0004) |
| 0017 | [Forgotten passwords: admin-assisted reset](0017-forgotten-password-recovery.md) | Accepted (extends 0012) |
| 0018 | [Tokens in per-tab sessionStorage](0018-per-tab-token-storage.md) | Superseded by 0019 |
| 0019 | [Tokens in HttpOnly cookies](0019-httponly-cookie-tokens.md) | Accepted (supersedes 0018 and the bearer transport of 0015) |

No further decisions are planned.

## Phase 0 decisions (recorded in `.claude/tasks/phase-status.md`)
Workspace root layout (no nested `poc/`), Git remote configured without pushing, requirements derived from the prompt only.
