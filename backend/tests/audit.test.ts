import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresErrorCode } from '../src/errors/prisma-errors.js';
import {
  buildTestApp,
  createProjectWithTask,
  createTestPrisma,
  createUser,
  loginToken,
  resetDatabase,
  type ApiErrorBody,
} from './helpers.js';

const prisma = createTestPrisma();
const app = buildTestApp(prisma);

const WEEK = '2026-03-09'; // Monday

type Who = 'admin' | 'ma' | 'mb' | 'dev' | 'dev2';
let cookies: Record<Who, string>;
let ids: Record<Who, string>;
let task: { projectId: string; taskId: string };

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  actor: { id: string; name: string };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const admin = await createUser(prisma, {
    email: 'admin@t.dev',
    role: 'ADMIN',
    name: 'Alex Admin',
  });
  const ma = await createUser(prisma, { email: 'ma@t.dev', role: 'MANAGER' });
  const mb = await createUser(prisma, { email: 'mb@t.dev', role: 'MANAGER' });
  const dev = await createUser(prisma, { email: 'dev@t.dev', managerId: ma.id });
  const dev2 = await createUser(prisma, { email: 'dev2@t.dev', managerId: ma.id });
  const { project, task: t } = await createProjectWithTask(prisma, { code: 'P1' });
  task = { projectId: project.id, taskId: t.id };
  ids = { admin: admin.id, ma: ma.id, mb: mb.id, dev: dev.id, dev2: dev2.id };
  cookies = {} as Record<Who, string>;
  for (const who of ['admin', 'ma', 'mb', 'dev', 'dev2'] as const) {
    cookies[who] = await loginToken(app, `${who}@t.dev`);
  }
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const as = (who: Who) => ({
  get: (path: string) => request(app).get(path).set('Cookie', cookies[who]),
  post: (path: string, body?: object) =>
    request(app).post(path).set('Cookie', cookies[who]).send(body),
});
const auditRows = (where = {}) =>
  prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } });

async function submitWeek(who: Who = 'dev'): Promise<string> {
  await as(who).post('/api/time-entries', { ...task, workDate: WEEK, hours: 8, isBillable: true });
  const res = await as(who).post('/api/submissions', { weekStart: WEEK });
  expect(res.status).toBe(201);
  return (res.body as { submission: { id: string } }).submission.id;
}

describe('workflow actions are recorded in the audit trail', () => {
  it('records a submission with its actor and context', async () => {
    const id = await submitWeek();

    const rows = await auditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: ids.dev,
      action: 'SUBMISSION_SUBMITTED',
      entityType: 'weekly_submission',
      entityId: id,
    });
    expect(rows[0]!.metadata).toEqual({ userId: ids.dev, weekStart: WEEK, resubmission: false });
  });

  it('records reject, resubmit and approve in order, with the manager comment', async () => {
    const id = await submitWeek();
    await as('ma').post(`/api/submissions/${id}/reject`, { comment: 'Add Friday' });
    await as('dev').post('/api/submissions', { weekStart: WEEK });
    await as('ma').post(`/api/submissions/${id}/approve`, { comment: 'Thanks' });

    const rows = await auditRows();

    expect(rows.map((r) => r.action)).toEqual([
      'SUBMISSION_SUBMITTED',
      'SUBMISSION_REJECTED',
      'SUBMISSION_SUBMITTED',
      'SUBMISSION_APPROVED',
    ]);
    expect(rows.map((r) => r.actorId)).toEqual([ids.dev, ids.ma, ids.dev, ids.ma]);
    expect(rows[1]!.metadata).toMatchObject({
      comment: 'Add Friday',
      userId: ids.dev,
      weekStart: WEEK,
    });
    expect(rows[2]!.metadata).toMatchObject({ resubmission: true });
    expect(rows.every((r) => r.entityId === id)).toBe(true);
  });

  it('writes nothing when the action is refused (audit and action commit together)', async () => {
    const id = await submitWeek();
    const before = await prisma.auditLog.count();

    const outsideManager = await as('mb').post(`/api/submissions/${id}/approve`);
    const colleague = await as('dev2').post(`/api/submissions/${id}/approve`);
    const emptyWeek = await as('dev2').post('/api/submissions', { weekStart: '2026-03-16' });
    const duplicate = await as('dev').post('/api/submissions', { weekStart: WEEK });
    await as('ma').post(`/api/submissions/${id}/approve`);
    const secondDecision = await as('ma').post(`/api/submissions/${id}/reject`, {
      comment: 'late',
    });

    expect([
      outsideManager.status,
      colleague.status,
      emptyWeek.status,
      duplicate.status,
      secondDecision.status,
    ]).toEqual([404, 403, 422, 409, 409]);
    expect(await prisma.auditLog.count()).toBe(before + 1); // only the one successful approval
  });
});

describe('GET /api/audit-logs', () => {
  async function seedTrail() {
    const id = await submitWeek();
    await as('ma').post(`/api/submissions/${id}/approve`);
    await as('admin').post('/api/locked-periods', { period: '2026-03', note: 'close' });
    await as('admin').post('/api/locked-periods/2026-03/unlock', { reason: 'late invoice fix' });
    return id;
  }

  it('shows admins the full trail, newest first, with actor names', async () => {
    await seedTrail();

    const res = await as('admin').get('/api/audit-logs');

    expect(res.status).toBe(200);
    const logs = (res.body as { auditLogs: AuditRow[] }).auditLogs;
    expect(logs.map((l) => l.action)).toEqual([
      'PERIOD_UNLOCKED',
      'PERIOD_LOCKED',
      'SUBMISSION_APPROVED',
      'SUBMISSION_SUBMITTED',
    ]);
    expect(logs[0]!.actor).toMatchObject({ id: ids.admin, name: 'Alex Admin' });
    expect(logs[0]!.metadata).toMatchObject({ reason: 'late invoice fix', period: '2026-03' });
    expect(JSON.stringify(logs)).not.toMatch(/passwordHash|argon2/);
  });

  it('is admin only', async () => {
    await seedTrail();

    for (const who of ['dev', 'ma', 'mb'] as const) {
      const res = await as(who).get('/api/audit-logs');
      expect(res.status).toBe(403);
      expect((res.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
    }
    expect((await request(app).get('/api/audit-logs')).status).toBe(401);
  });

  it('filters by action, entity and actor', async () => {
    const submissionId = await seedTrail();

    const byAction = await as('admin').get('/api/audit-logs?action=PERIOD_LOCKED');
    const byEntity = await as('admin').get(`/api/audit-logs?entityId=${submissionId}`);
    const byActor = await as('admin').get(`/api/audit-logs?actorId=${ids.ma}`);
    const byType = await as('admin').get('/api/audit-logs?entityType=locked_period');

    const actions = (r: request.Response) =>
      (r.body as { auditLogs: AuditRow[] }).auditLogs.map((l) => l.action);
    expect(actions(byAction)).toEqual(['PERIOD_LOCKED']);
    expect(actions(byEntity)).toEqual(['SUBMISSION_APPROVED', 'SUBMISSION_SUBMITTED']);
    expect(actions(byActor)).toEqual(['SUBMISSION_APPROVED']);
    expect(actions(byType)).toEqual(['PERIOD_UNLOCKED', 'PERIOD_LOCKED']);
  });

  it('paginates and validates query parameters', async () => {
    await seedTrail();

    const page = await as('admin').get('/api/audit-logs?limit=2&offset=1');
    expect((page.body as { auditLogs: AuditRow[] }).auditLogs.map((l) => l.action)).toEqual([
      'PERIOD_LOCKED',
      'SUBMISSION_APPROVED',
    ]);
    for (const bad of ['limit=0', 'limit=500', 'offset=-1', 'action=NOPE', 'entityId=nope']) {
      expect((await as('admin').get(`/api/audit-logs?${bad}`)).status).toBe(400);
    }
  });
});

describe('the audit trail is append-only at the database level (SQLSTATE LK002)', () => {
  async function oneRow() {
    await submitWeek();
    return prisma.auditLog.findFirstOrThrow();
  }
  const codeOf = async (p: Promise<unknown>) => postgresErrorCode(await p.catch((e: unknown) => e));

  it('rejects UPDATE and DELETE through the ORM and through raw SQL', async () => {
    const row = await oneRow();

    expect(
      await codeOf(
        prisma.auditLog.update({ where: { id: row.id }, data: { action: 'PERIOD_UNLOCKED' } }),
      ),
    ).toBe('LK002');
    expect(await codeOf(prisma.auditLog.delete({ where: { id: row.id } }))).toBe('LK002');
    expect(await codeOf(prisma.auditLog.deleteMany())).toBe('LK002');
    expect(
      await codeOf(
        prisma.$executeRaw`UPDATE audit_logs SET metadata = '{}'::jsonb WHERE id = ${row.id}::uuid`,
      ),
    ).toBe('LK002');
    expect(await codeOf(prisma.$executeRaw`DELETE FROM audit_logs`)).toBe('LK002');

    expect(await prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it('still accepts new rows', async () => {
    const row = await oneRow();

    await expect(
      prisma.auditLog.create({
        data: {
          actorId: row.actorId,
          action: 'PERIOD_LOCKED',
          entityType: 'locked_period',
          entityId: row.entityId,
        },
      }),
    ).resolves.toBeTruthy();
  });
});
