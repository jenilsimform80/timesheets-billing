import type { Json } from './schema-utils.js';

const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` });
const uuid: Json = { type: 'string', format: 'uuid' };
const date: Json = { type: 'string', format: 'date', example: '2026-03-02' };
const dateTime: Json = { type: 'string', format: 'date-time' };
const nullable = (schema: Json): Json => ({ ...schema, nullable: true });
const obj = (
  properties: Record<string, Json>,
  required: string[] = Object.keys(properties),
): Json => ({
  type: 'object',
  properties,
  required,
});
const arrayOf = (items: Json): Json => ({ type: 'array', items });
const ROLE: Json = { type: 'string', enum: ['CONTRIBUTOR', 'MANAGER', 'ADMIN'] };
const SUBMISSION_STATUS: Json = { type: 'string', enum: ['SUBMITTED', 'APPROVED', 'REJECTED'] };

export { ref };

/** Response and shared schemas. Request bodies/parameters are generated from the Zod validators. */
export const componentSchemas: Record<string, Json> = {
  ErrorResponse: obj({
    error: obj(
      {
        code: {
          type: 'string',
          description: 'Stable machine-readable code.',
          example: 'NOT_FOUND',
          enum: [
            'VALIDATION_ERROR',
            'UNAUTHENTICATED',
            'FORBIDDEN',
            'PASSWORD_CHANGE_REQUIRED',
            'NOT_FOUND',
            'CONFLICT',
            'PERIOD_LOCKED',
            'BUSINESS_RULE_VIOLATION',
            'DAILY_LIMIT_EXCEEDED',
            'WEEK_NOT_EDITABLE',
            'INVALID_STATE',
            'RATE_LIMITED',
            'PAYLOAD_TOO_LARGE',
            'UNSUPPORTED_MEDIA_TYPE',
            'BAD_REQUEST',
            'SERVICE_UNAVAILABLE',
            'INTERNAL_ERROR',
          ],
        },
        message: { type: 'string', example: 'Project not found' },
        details: { description: 'Optional extra data; its shape depends on the code.' },
      },
      ['code', 'message'],
    ),
  }),
  ValidationIssue: obj({
    location: { type: 'string', enum: ['body', 'params', 'query'] },
    path: { type: 'string', example: 'hours' },
    message: { type: 'string' },
  }),
  ValidationErrorResponse: obj({
    error: obj(
      {
        code: { type: 'string', enum: ['VALIDATION_ERROR'] },
        message: { type: 'string', example: 'Request validation failed' },
        details: arrayOf(ref('ValidationIssue')),
      },
      ['code', 'message'],
    ),
  }),

  Health: obj({
    status: { type: 'string', enum: ['ok'] },
    uptimeSeconds: { type: 'integer' },
    timestamp: dateTime,
  }),
  DatabaseHealth: obj({
    status: { type: 'string', enum: ['ok', 'unavailable'] },
    database: { type: 'string', enum: ['up', 'down'] },
  }),

  SessionUser: obj({
    id: uuid,
    email: { type: 'string', format: 'email' },
    name: { type: 'string' },
    role: ROLE,
    managerId: nullable(uuid),
    mustChangePassword: {
      type: 'boolean',
      description:
        'True after an admin reset: every route except /auth/me and /auth/change-password answers 403 PASSWORD_CHANGE_REQUIRED until the user changes it.',
    },
  }),
  User: obj({
    id: uuid,
    email: { type: 'string', format: 'email' },
    name: { type: 'string' },
    role: ROLE,
    managerId: nullable(uuid),
    isActive: { type: 'boolean' },
  }),

  Task: obj(
    {
      id: uuid,
      name: { type: 'string' },
      isActive: { type: 'boolean' },
      canLog: {
        type: 'boolean',
        description: 'false when the task is assigned only to other people.',
      },
      canManage: {
        type: 'boolean',
        description: 'true for admins and for the manager who created the task.',
      },
      assigneeIds: {
        ...arrayOf(uuid),
        description: 'Only present when `canManage`. Empty = open to everyone.',
      },
    },
    ['id', 'name', 'isActive', 'canLog', 'canManage'],
  ),
  Project: obj(
    {
      id: uuid,
      code: { type: 'string', example: 'ALPHA' },
      name: { type: 'string' },
      clientName: nullable({ type: 'string' }),
      budgetHours: {
        type: 'number',
        description: 'Allocated hours. **Omitted for non-admins** (commercial information).',
      },
      startDate: nullable(date),
      endDate: nullable(date),
      isActive: { type: 'boolean', description: 'false = archived.' },
      isRestricted: {
        type: 'boolean',
        description: 'true = only members (and admins) can see it and log time to it.',
      },
      memberIds: {
        ...arrayOf(uuid),
        description: '**Admins only.** Members of a restricted project.',
      },
      tasks: arrayOf(ref('Task')),
    },
    ['id', 'code', 'name', 'clientName', 'startDate', 'endDate', 'isActive', 'isRestricted'],
  ),

  TimeEntry: obj({
    id: uuid,
    userId: uuid,
    projectId: uuid,
    taskId: uuid,
    workDate: date,
    hours: { type: 'number', example: 7.5 },
    isBillable: { type: 'boolean' },
    notes: nullable({ type: 'string' }),
    createdAt: dateTime,
    updatedAt: dateTime,
  }),
  TimesheetWarning: obj(
    {
      code: { type: 'string', enum: ['DAILY_HOURS_HIGH', 'WEEKLY_HOURS_HIGH'] },
      message: { type: 'string' },
      total: { type: 'number' },
      threshold: { type: 'number' },
      date: { ...date, description: 'Present for daily warnings only.' },
    },
    ['code', 'message', 'total', 'threshold'],
  ),
  TimeEntryWriteResult: obj({
    entry: ref('TimeEntry'),
    warnings: arrayOf(ref('TimesheetWarning')),
  }),
  WeekSummary: obj({
    userId: uuid,
    weekStart: date,
    weekEnd: date,
    status: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'] },
    submission: nullable(
      obj({ id: uuid, status: SUBMISSION_STATUS, submittedAt: nullable(dateTime) }),
    ),
    entries: arrayOf(ref('TimeEntry')),
    dailyTotals: {
      type: 'object',
      additionalProperties: { type: 'number' },
      description: 'Total hours per ISO date that has entries.',
    },
    weeklyTotal: { type: 'number' },
    billableTotal: { type: 'number' },
    nonBillableTotal: { type: 'number' },
    warnings: arrayOf(ref('TimesheetWarning')),
  }),

  Approval: obj({
    id: uuid,
    managerId: uuid,
    decision: { type: 'string', enum: ['APPROVED', 'REJECTED'] },
    comment: nullable({ type: 'string' }),
    decidedAt: dateTime,
  }),
  Submission: obj(
    {
      id: uuid,
      userId: uuid,
      weekStart: date,
      status: SUBMISSION_STATUS,
      submittedAt: nullable(dateTime),
      updatedAt: dateTime,
      approvals: { ...arrayOf(ref('Approval')), description: 'Only on `GET /submissions/{id}`.' },
    },
    ['id', 'userId', 'weekStart', 'status', 'submittedAt', 'updatedAt'],
  ),

  LockedPeriod: obj({
    period: { type: 'string', example: '2026-03', description: 'Calendar month, YYYY-MM.' },
    lockedAt: dateTime,
    note: nullable({ type: 'string' }),
    lockedBy: obj({ id: uuid, name: { type: 'string' } }),
  }),
  AuditLog: obj({
    id: uuid,
    action: {
      type: 'string',
      enum: [
        'SUBMISSION_SUBMITTED',
        'SUBMISSION_APPROVED',
        'SUBMISSION_REJECTED',
        'PERIOD_LOCKED',
        'PERIOD_UNLOCKED',
        'PASSWORD_RESET',
      ],
    },
    entityType: { type: 'string', enum: ['weekly_submission', 'locked_period', 'user'] },
    entityId: { type: 'string', description: 'A submission id, a user id or a YYYY-MM period.' },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description: 'Snapshot of the action.',
    },
    createdAt: dateTime,
    actor: obj({ id: uuid, name: { type: 'string' }, email: { type: 'string', format: 'email' } }),
  }),

  HoursReport: obj({
    from: date,
    to: date,
    groupBy: arrayOf({ type: 'string', enum: ['contributor', 'project', 'month'] }),
    rows: arrayOf(
      obj(
        {
          userId: uuid,
          userName: { type: 'string' },
          projectId: uuid,
          projectCode: { type: 'string' },
          projectName: { type: 'string' },
          month: { type: 'string', example: '2026-03' },
          totalHours: { type: 'number' },
          billableHours: { type: 'number' },
          nonBillableHours: { type: 'number' },
          entryCount: { type: 'integer' },
        },
        ['totalHours', 'billableHours', 'nonBillableHours', 'entryCount'],
      ),
    ),
    totals: obj({
      totalHours: { type: 'number' },
      billableHours: { type: 'number' },
      nonBillableHours: { type: 'number' },
      entryCount: { type: 'integer' },
    }),
    truncated: { type: 'boolean', description: 'true when more than 5000 rows existed.' },
  }),
  BudgetReport: obj({
    through: nullable(date),
    projects: arrayOf(
      obj({
        projectId: uuid,
        code: { type: 'string' },
        name: { type: 'string' },
        isActive: { type: 'boolean' },
        budgetHours: { type: 'number' },
        loggedHours: { type: 'number' },
        billableHours: { type: 'number' },
        nonBillableHours: { type: 'number' },
        remainingHours: { type: 'number', description: 'May be negative.' },
        percentUsed: nullable({ type: 'number' }),
        status: { type: 'string', enum: ['OK', 'WARNING', 'OVER'] },
      }),
    ),
    totals: obj({ budgetHours: { type: 'number' }, loggedHours: { type: 'number' } }),
  }),
};

/** `{ key: Schema }` and `{ key: Schema[] }` envelopes the API wraps resources in. */
function envelopes(entries: [name: string, key: string, item: string, many: boolean][]): void {
  for (const [name, key, item, many] of entries) {
    componentSchemas[name] = obj({ [key]: many ? arrayOf(ref(item)) : ref(item) });
  }
}
envelopes([
  ['SessionUserResult', 'user', 'SessionUser', false],
  ['UserResult', 'user', 'User', false],
  ['UserList', 'users', 'User', true],
  ['ProjectResult', 'project', 'Project', false],
  ['ProjectList', 'projects', 'Project', true],
  ['TaskResult', 'task', 'Task', false],
  ['TimeEntryResult', 'entry', 'TimeEntry', false],
  ['TimeEntryList', 'entries', 'TimeEntry', true],
  ['SubmissionResult', 'submission', 'Submission', false],
  ['SubmissionList', 'submissions', 'Submission', true],
  ['LockedPeriodResult', 'lockedPeriod', 'LockedPeriod', false],
  ['LockedPeriodList', 'lockedPeriods', 'LockedPeriod', true],
  ['AuditLogList', 'auditLogs', 'AuditLog', true],
]);
