import type { ZodType } from 'zod';
import { changePasswordSchemas, loginSchemas } from '../validation/auth.schemas.js';
import { listAuditSchemas } from '../validation/audit.schemas.js';
import { lockPeriodSchemas, unlockPeriodSchemas } from '../validation/locked-periods.schemas.js';
import {
  createProjectSchemas,
  createTaskSchemas,
  listProjectsSchemas,
  projectIdSchemas,
  updateProjectSchemas,
  updateTaskSchemas,
} from '../validation/projects.schemas.js';
import { budgetReportSchemas, hoursReportSchemas } from '../validation/reports.schemas.js';
import {
  approveSchemas,
  listSubmissionsSchemas,
  rejectSchemas,
  submissionIdSchemas,
  submitWeekSchemas,
} from '../validation/submissions.schemas.js';
import {
  createEntrySchemas,
  entryIdSchemas,
  listEntriesSchemas,
  updateEntrySchemas,
  weekSchemas,
} from '../validation/time-entries.schemas.js';
import {
  createUserSchemas,
  getUserSchemas,
  resetPasswordSchemas,
  updateUserSchemas,
} from '../validation/users.schemas.js';

export type Access = 'public' | 'any' | 'CONTRIBUTOR' | 'MANAGER' | 'ADMIN' | 'ADMIN_OR_MANAGER';
type HttpMethod = 'get' | 'post' | 'patch' | 'delete';

export interface RequestSchemas {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  /** false when the body may be omitted entirely. */
  bodyRequired?: boolean;
}

export interface OperationSpec {
  method: HttpMethod;
  /** Express-style path relative to `/api`, e.g. `/projects/:id`. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  access: Access;
  request?: RequestSchemas;
  /** Descriptions for parameters (by name). */
  paramDocs?: Record<string, string>;
  success: { status: 200 | 201 | 204; description: string; schema?: string };
  /** Extra error statuses beyond the automatic 400/401/403. */
  errors?: Partial<Record<400 | 401 | 403 | 404 | 409 | 422 | 429 | 503, string>>;
}

const FROZEN =
  'The week is SUBMITTED or APPROVED (`WEEK_NOT_EDITABLE`, `details: {weekStart, status}`), or the date is in a locked month (`PERIOD_LOCKED`, `details: {period, enforcedBy}`).';

export const operations: OperationSpec[] = [
  // ---- Health ----
  {
    method: 'get',
    path: '/health',
    tag: 'Health',
    summary: 'Liveness check',
    access: 'public',
    success: { status: 200, description: 'The process is up.', schema: 'Health' },
  },
  {
    method: 'get',
    path: '/health/db',
    tag: 'Health',
    summary: 'Database connectivity check',
    description: 'Runs `SELECT 1`. Reveals only up/down; no error details.',
    access: 'public',
    success: { status: 200, description: 'Database reachable.', schema: 'DatabaseHealth' },
  },

  // ---- Auth ----
  {
    method: 'post',
    path: '/auth/login',
    tag: 'Auth',
    summary: 'Sign in (sets the HttpOnly token cookies)',
    description:
      'The access and refresh tokens are set as HttpOnly cookies (never in the body); the browser sends them on later calls. A wrong password, unknown email and deactivated account give the **same** 401. Failed attempts are rate-limited per IP.',
    access: 'public',
    request: { body: loginSchemas.body },
    success: {
      status: 200,
      description: 'Signed in. Sets the access and refresh cookies; the body has only the user.',
      schema: 'SessionUserResult',
    },
    errors: {
      401: 'Invalid email or password.',
      429: 'Too many (failed) login attempts from this IP (`RATE_LIMITED`).',
    },
  },
  {
    method: 'post',
    path: '/auth/refresh',
    tag: 'Auth',
    summary: 'Rotate the refresh cookie and get a new access cookie',
    description:
      'Reads the refresh token from its cookie (no body). Rotation: the presented refresh token is replaced and can never be used again. The session keeps its original absolute expiry. Counts toward the per-IP login attempt limit.',
    access: 'public',
    success: {
      status: 200,
      description: 'New access and refresh cookies are set.',
      schema: 'SessionUserResult',
    },
    errors: {
      401: 'Missing, unknown, already-used or expired refresh cookie, or the user is deactivated. Both cookies are cleared.',
      429: 'Too many attempts from this IP (`RATE_LIMITED`).',
    },
  },
  {
    method: 'post',
    path: '/auth/logout',
    tag: 'Auth',
    summary: 'Sign out',
    description:
      'Ends the session identified by the refresh cookie (the access cookie stops working at once) and clears both cookies. Always 204, even without a cookie.',
    access: 'public',
    success: { status: 204, description: 'Signed out.' },
  },
  {
    method: 'get',
    path: '/auth/me',
    tag: 'Auth',
    summary: 'Current user',
    access: 'any',
    success: { status: 200, description: 'The signed-in user.', schema: 'SessionUserResult' },
  },
  {
    method: 'post',
    path: '/auth/change-password',
    tag: 'Auth',
    summary: 'Change your own password',
    description:
      'Requires the current password. Ends every **other** session of the user; the session of the access token used stays signed in. Wrong attempts count toward the failed-login rate limit.',
    access: 'any',
    request: { body: changePasswordSchemas.body },
    success: { status: 204, description: 'Password changed.' },
    errors: {
      401: 'Not signed in, or the current password is incorrect.',
      422: 'The new password equals the current one (`BUSINESS_RULE_VIOLATION`).',
      429: 'Too many failed attempts (`RATE_LIMITED`).',
    },
  },

  // ---- Users ----
  {
    method: 'get',
    path: '/users',
    tag: 'Users',
    summary: 'List users you may see',
    description:
      'Scoped by role: contributor = self; manager = self + direct reports; admin = everyone.',
    access: 'any',
    success: { status: 200, description: 'Users in scope.', schema: 'UserList' },
  },
  {
    method: 'post',
    path: '/users',
    tag: 'Users',
    summary: 'Create a contributor or manager',
    description:
      'Admin only. There is no public signup. `managerId` is **required for CONTRIBUTOR** and optional for MANAGER (a manager may report to another manager, who then approves their timesheet). Admins cannot be created through the API. The password is stored as an argon2id hash and never returned.',
    access: 'ADMIN',
    request: { body: createUserSchemas.body },
    success: { status: 201, description: 'User created.', schema: 'UserResult' },
    errors: {
      409: 'A user with this email already exists (case-insensitive).',
      422: '`managerId` is not an active user with role MANAGER.',
    },
  },
  {
    method: 'get',
    path: '/users/direct-reports',
    tag: 'Users',
    summary: 'List your direct reports',
    description: 'MANAGER only (admins get 403).',
    access: 'MANAGER',
    success: { status: 200, description: 'Direct reports.', schema: 'UserList' },
  },
  {
    method: 'get',
    path: '/users/:id',
    tag: 'Users',
    summary: 'Get one user',
    access: 'any',
    request: { params: getUserSchemas.params },
    success: { status: 200, description: 'The user.', schema: 'UserResult' },
    errors: {
      404: 'No such user **or** outside your scope (indistinguishable, so ids cannot be probed).',
    },
  },
  {
    method: 'patch',
    path: '/users/:id',
    tag: 'Users',
    summary: 'Edit a user (name, role, manager, active)',
    description:
      "Admin only. Send at least one field. Email cannot be changed. Setting `isActive: false` ends all of the user's sessions at once. Role is CONTRIBUTOR or MANAGER only.",
    access: 'ADMIN',
    request: { params: updateUserSchemas.params, body: updateUserSchemas.body },
    success: { status: 200, description: 'Updated user.', schema: 'UserResult' },
    errors: {
      404: 'No such user.',
      422: 'Admin accounts cannot be changed here; a contributor needs an active manager; a manager can only report to an active manager, never in a loop; or a manager with active direct reports cannot be deactivated or demoted (`BUSINESS_RULE_VIOLATION`).',
    },
  },
  {
    method: 'post',
    path: '/users/:id/password',
    tag: 'Users',
    summary: "Reset a user's password",
    description:
      "Admin only. Ends all of that user's sessions. Admin accounts are refused (they change their own).",
    access: 'ADMIN',
    request: { params: resetPasswordSchemas.params, body: resetPasswordSchemas.body },
    success: { status: 204, description: 'Password replaced.' },
    errors: { 404: 'No such user.', 422: 'Target is an admin account.' },
  },

  // ---- Projects ----
  {
    method: 'get',
    path: '/projects',
    tag: 'Projects',
    summary: 'List projects',
    description:
      'Active projects with their active tasks. Restricted projects appear only for their members (and admins). `budgetHours` and `memberIds` are omitted for non-admins. `includeArchived=true` is admin only.',
    access: 'any',
    request: { query: listProjectsSchemas.query },
    success: { status: 200, description: 'Projects.', schema: 'ProjectList' },
    errors: { 403: '`includeArchived=true` by a non-admin.' },
  },
  {
    method: 'post',
    path: '/projects',
    tag: 'Projects',
    summary: 'Create a project',
    description:
      'Set `isRestricted: true` with `memberIds` to limit the project to those users; otherwise every signed-in user can log time to it.',
    access: 'ADMIN',
    request: { body: createProjectSchemas.body },
    success: { status: 201, description: 'Project created.', schema: 'ProjectResult' },
    errors: {
      409: 'Project code already exists.',
      422: '`endDate` is before `startDate`; `memberIds` given for an open project, or not all active contributors/managers.',
    },
  },
  {
    method: 'get',
    path: '/projects/:id',
    tag: 'Projects',
    summary: 'Get one project',
    access: 'any',
    request: { params: projectIdSchemas.params },
    success: { status: 200, description: 'The project with its tasks.', schema: 'ProjectResult' },
    errors: {
      404: 'Not found, archived (non-admin), or restricted and the caller is not a member.',
    },
  },
  {
    method: 'patch',
    path: '/projects/:id',
    tag: 'Projects',
    summary: 'Edit or archive a project',
    description:
      'Send at least one field. `isActive: false` archives (no deletion). Optional fields may be set to `null` to clear them. `memberIds` replaces the whole member list; removing a member blocks only new entries.',
    access: 'ADMIN',
    request: { params: updateProjectSchemas.params, body: updateProjectSchemas.body },
    success: { status: 200, description: 'Updated project.', schema: 'ProjectResult' },
    errors: {
      404: 'Project not found.',
      409: 'Project code already exists.',
      422: '`endDate` is before `startDate`; invalid `memberIds`.',
    },
  },
  {
    method: 'post',
    path: '/projects/:id/tasks',
    tag: 'Projects',
    summary: 'Add a task to a project',
    description:
      'Admins, and managers on projects they can see. `assigneeIds` limits who may log time to the task (empty or omitted = everyone who can use the project). A manager may only assign themself or their active direct reports; on a restricted project assignees must be members.',
    access: 'ADMIN_OR_MANAGER',
    request: { params: createTaskSchemas.params, body: createTaskSchemas.body },
    success: { status: 201, description: 'Task created.', schema: 'TaskResult' },
    errors: {
      404: 'Project not found or not visible to the caller.',
      409: 'A task with this name already exists in the project.',
      422: 'Invalid `assigneeIds`, or the project is archived (managers).',
    },
  },
  {
    method: 'patch',
    path: '/projects/:id/tasks/:taskId',
    tag: 'Projects',
    summary: 'Rename, archive or re-assign a task',
    description:
      'Admins may change any task; managers only tasks they created (403 otherwise). `assigneeIds` replaces the assignee list; an empty list opens the task to everyone.',
    access: 'ADMIN_OR_MANAGER',
    request: { params: updateTaskSchemas.params, body: updateTaskSchemas.body },
    success: { status: 200, description: 'Updated task.', schema: 'TaskResult' },
    errors: {
      403: 'A manager changing a task they did not create.',
      404: 'Task or project not found (or project not visible).',
      409: 'Name already used in the project.',
      422: 'Invalid `assigneeIds`.',
    },
  },

  // ---- Time entries ----
  {
    method: 'post',
    path: '/time-entries',
    tag: 'Time entries',
    summary: 'Log hours',
    description:
      "The owner is always the caller. Hours: more than 0 and at most 24, in 0.25 steps. A user's total for one day may not exceed 24 h. Warnings (above 10 h/day or 48 h/week) never block.",
    access: 'any',
    request: { body: createEntrySchemas.body },
    success: {
      status: 201,
      description: 'Entry created, with any warnings.',
      schema: 'TimeEntryWriteResult',
    },
    errors: {
      404: 'Project not found.',
      409: FROZEN,
      422: 'Archived project/task, task not in the project, date outside the project window (`BUSINESS_RULE_VIOLATION`), or the day would exceed 24 h (`DAILY_LIMIT_EXCEEDED`).',
    },
  },
  {
    method: 'get',
    path: '/time-entries',
    tag: 'Time entries',
    summary: 'List entries in a date range',
    description:
      'Defaults to your own entries. `userId` must be in your scope (self, a direct report for managers, anyone for admins). At most 1000 rows; `from ≤ to`; range at most 366 days.',
    access: 'any',
    request: { query: listEntriesSchemas.query },
    success: { status: 200, description: 'Entries.', schema: 'TimeEntryList' },
    errors: { 404: '`userId` outside your scope.' },
  },
  {
    method: 'get',
    path: '/time-entries/:id',
    tag: 'Time entries',
    summary: 'Get one entry',
    description: "Visible to the owner, the owner's manager and admins.",
    access: 'any',
    request: { params: entryIdSchemas.params },
    success: { status: 200, description: 'The entry.', schema: 'TimeEntryResult' },
    errors: { 404: 'Not found or not visible to you.' },
  },
  {
    method: 'patch',
    path: '/time-entries/:id',
    tag: 'Time entries',
    summary: 'Edit an entry',
    description:
      'Owner only. Send at least one field; `taskId` is required when `projectId` changes. Project/task/date rules are re-checked only when project, task or date change.',
    access: 'any',
    request: { params: updateEntrySchemas.params, body: updateEntrySchemas.body },
    success: {
      status: 200,
      description: 'Updated entry, with any warnings.',
      schema: 'TimeEntryWriteResult',
    },
    errors: {
      403: 'The entry is visible to you but is not yours.',
      404: 'Not found or not visible to you.',
      409: FROZEN,
      422: 'Same business rules as creating an entry.',
    },
  },
  {
    method: 'delete',
    path: '/time-entries/:id',
    tag: 'Time entries',
    summary: 'Delete an entry',
    description: 'Owner only.',
    access: 'any',
    request: { params: entryIdSchemas.params },
    success: { status: 204, description: 'Deleted.' },
    errors: {
      403: 'The entry is visible to you but is not yours.',
      404: 'Not found or not visible to you.',
      409: FROZEN,
    },
  },
  {
    method: 'get',
    path: '/timesheets/:weekStart',
    tag: 'Time entries',
    summary: "One user's week with totals and submission status",
    description: '`weekStart` must be a Monday (ISO week).',
    access: 'any',
    request: { params: weekSchemas.params, query: weekSchemas.query },
    success: { status: 200, description: 'The week.', schema: 'WeekSummary' },
    errors: { 404: '`userId` outside your scope.' },
  },

  // ---- Submissions ----
  {
    method: 'post',
    path: '/submissions',
    tag: 'Submissions',
    summary: 'Submit a week for approval',
    description:
      'Your own week only. Needs at least one entry and an assigned manager who is an **active MANAGER**. A REJECTED week can be resubmitted. The week is then frozen.',
    access: 'any',
    request: { body: submitWeekSchemas.body },
    success: { status: 201, description: 'Submitted.', schema: 'SubmissionResult' },
    errors: {
      409: 'The week is already SUBMITTED or APPROVED (`INVALID_STATE`).',
      422: 'Empty week, or no active manager assigned (`BUSINESS_RULE_VIOLATION`).',
    },
  },
  {
    method: 'get',
    path: '/submissions',
    tag: 'Submissions',
    summary: 'List submissions',
    description:
      "Scoped: contributor = own; manager = own + reports; admin = all. `forApproval=true` (MANAGER or ADMIN) lists what the caller may decide (a manager's direct reports; for an admin, people with no usable manager) and **defaults to `status=SUBMITTED`**.",
    access: 'any',
    request: { query: listSubmissionsSchemas.query },
    success: { status: 200, description: 'Submissions.', schema: 'SubmissionList' },
    errors: { 403: '`forApproval=true` by a non-manager.', 404: '`userId` outside your scope.' },
  },
  {
    method: 'get',
    path: '/submissions/:id',
    tag: 'Submissions',
    summary: 'Get one submission with its approval history',
    access: 'any',
    request: { params: submissionIdSchemas.params },
    success: { status: 200, description: 'The submission.', schema: 'SubmissionResult' },
    errors: { 404: 'Not found or not visible to you.' },
  },
  {
    method: 'post',
    path: '/submissions/:id/approve',
    tag: 'Submissions',
    summary: 'Approve a submission',
    description:
      "Only the **owner's current direct manager** (role MANAGER). Admins cannot approve.",
    access: 'MANAGER',
    request: { params: approveSchemas.params, body: approveSchemas.body, bodyRequired: false },
    success: { status: 200, description: 'Approved.', schema: 'SubmissionResult' },
    errors: {
      404: "Not found, or not your direct report's submission.",
      409: 'Not in SUBMITTED state (`INVALID_STATE`).',
    },
  },
  {
    method: 'post',
    path: '/submissions/:id/reject',
    tag: 'Submissions',
    summary: 'Reject a submission',
    description:
      'Same authority as approve. A non-blank `comment` is required. The week reopens for editing. Refused if any day of the week is in a locked month.',
    access: 'MANAGER',
    request: { params: rejectSchemas.params, body: rejectSchemas.body },
    success: { status: 200, description: 'Rejected.', schema: 'SubmissionResult' },
    errors: {
      404: "Not found, or not your direct report's submission.",
      409: 'Not in SUBMITTED state (`INVALID_STATE`), or the week touches a locked month (`PERIOD_LOCKED`).',
    },
  },

  // ---- Locked periods ----
  {
    method: 'get',
    path: '/locked-periods',
    tag: 'Locked periods',
    summary: 'List locked months',
    description: 'Any signed-in user (the UI needs it to disable editing). Newest first.',
    access: 'any',
    success: { status: 200, description: 'Locked months.', schema: 'LockedPeriodList' },
  },
  {
    method: 'post',
    path: '/locked-periods',
    tag: 'Locked periods',
    summary: 'Lock a calendar month',
    description:
      'Admin only. Afterwards no entry dated in the month can be created, changed or deleted by anyone (admins included). Enforced by the service **and** a database trigger. Writes an audit record with a snapshot.',
    access: 'ADMIN',
    request: { body: lockPeriodSchemas.body },
    success: { status: 201, description: 'Locked.', schema: 'LockedPeriodResult' },
    errors: { 409: 'The month is already locked (`CONFLICT`).' },
  },
  {
    method: 'post',
    path: '/locked-periods/:period/unlock',
    tag: 'Locked periods',
    summary: 'Unlock a month',
    description:
      'Admin only. A reason (3–500 characters) is mandatory and is written to the audit trail.',
    access: 'ADMIN',
    request: { params: unlockPeriodSchemas.params, body: unlockPeriodSchemas.body },
    success: { status: 204, description: 'Unlocked.' },
    errors: { 404: 'The month is not locked.' },
  },

  // ---- Audit ----
  {
    method: 'get',
    path: '/audit-logs',
    tag: 'Audit',
    summary: 'Read the audit trail',
    description: 'Admin only. Newest first. The table is append-only.',
    access: 'ADMIN',
    request: { query: listAuditSchemas.query },
    success: { status: 200, description: 'Audit records.', schema: 'AuditLogList' },
  },

  // ---- Reports ----
  {
    method: 'get',
    path: '/reports/hours',
    tag: 'Reports',
    summary: 'Hours report',
    description:
      'Scoped by role (contributor = own; manager = self + reports; admin = all). Dates are inclusive; `from ≤ to`; range at most 1830 days. `groupBy` is a comma-separated, duplicate-free, non-empty subset of `contributor`, `project`, `month`. Each row has only the requested dimensions plus the four measures. At most 5000 rows (`truncated`).',
    access: 'any',
    request: { query: hoursReportSchemas.query },
    paramDocs: { groupBy: 'e.g. `month` or `contributor,project,month`' },
    success: { status: 200, description: 'The report.', schema: 'HoursReport' },
    errors: { 404: '`userId` outside your scope.' },
  },
  {
    method: 'get',
    path: '/reports/project-budgets',
    tag: 'Reports',
    summary: 'Project budget usage',
    description:
      'Admin only. `status`: OK, WARNING at 80% or more of budget, OVER above 100%. `percentUsed` is null for a zero budget.',
    access: 'ADMIN',
    request: { query: budgetReportSchemas.query },
    success: { status: 200, description: 'Budget usage per project.', schema: 'BudgetReport' },
  },
];
