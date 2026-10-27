import { Prisma } from '../src/generated/prisma/client.js';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDatabaseHealth } from '../src/services/health.service.js';
import {
  buildTestApp,
  createProjectWithTask,
  createTestPrisma,
  createUser,
  loginToken,
  resetDatabase,
  type ApiErrorBody,
} from './helpers.js';

// Regression tests for the findings of the Phase 6 independent backend review.
const prisma = createTestPrisma();
const app = buildTestApp(prisma);

type Who = 'admin' | 'ma' | 'mb' | 'dev' | 'dev2';
let cookies: Record<Who, string>;
let ids: Record<Who, string>;
let task: { projectId: string; taskId: string };

beforeEach(async () => {
  await resetDatabase(prisma);
  const admin = await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
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
  patch: (path: string, body?: object) =>
    request(app).patch(path).set('Cookie', cookies[who]).send(body),
});
const errorOf = (res: request.Response) => (res.body as ApiErrorBody).error;

describe('finding 1: client-caused framework errors are 4xx, not 500', () => {
  it('answers an oversized body with 413', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.dev', password: 'x'.repeat(200_000) });

    expect(res.status).toBe(413);
    expect(errorOf(res).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('answers an unsupported content encoding with 415', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'x-unknown')
      .send('{"email":"a@b.dev","password":"x"}');

    expect(res.status).toBe(415);
    expect(errorOf(res).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('answers a corrupt compressed body with 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .send('{"email":"a@b.dev","password":"x"}'); // not actually gzip

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('answers a malformed percent-encoded URL with 400', async () => {
    const res = await as('dev').get('/api/projects/%E0%A4%A');

    expect(res.status).toBe(400);
  });

  it('never echoes framework error text back to the client', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.dev', password: 'x'.repeat(200_000) });

    expect(JSON.stringify(res.body)).not.toMatch(/limit|bytes|expected|received/i);
  });

  it('turns a database timeout or deadlock into a retryable 503, not an opaque 500', async () => {
    const { createErrorHandler } = await import('../src/middleware/error-handler.js');
    const handler = createErrorHandler({ logErrors: false });
    const send = (err: unknown) => {
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      handler(err, {} as never, res as never, (() => undefined) as never);
      return res;
    };
    const timeout = new Prisma.PrismaClientKnownRequestError('Transaction already closed', {
      code: 'P2028',
      clientVersion: 'test',
    });
    const deadlock = new Prisma.PrismaClientKnownRequestError('deadlock detected', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
    });

    for (const err of [timeout, deadlock]) {
      const res = send(err);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'SERVICE_UNAVAILABLE', message: expect.any(String) as string },
      });
    }
  });
});

describe('finding 2: editing an unrelated field must not re-validate an archived project', () => {
  it('lets the owner fix hours/notes/billable after the project was archived', async () => {
    const created = await as('dev').post('/api/time-entries', {
      ...task,
      workDate: '2026-03-10',
      hours: 4,
      isBillable: true,
    });
    const id = (created.body as { entry: { id: string } }).entry.id;
    await prisma.project.update({ where: { id: task.projectId }, data: { isActive: false } });
    await prisma.task.update({ where: { id: task.taskId }, data: { isActive: false } });

    const hoursOnly = await as('dev').patch(`/api/time-entries/${id}`, { hours: 2 });
    const notesOnly = await as('dev').patch(`/api/time-entries/${id}`, { notes: 'fixed' });
    const billable = await as('dev').patch(`/api/time-entries/${id}`, { isBillable: false });

    expect([hoursOnly.status, notesOnly.status, billable.status]).toEqual([200, 200, 200]);
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id } })).hours.toString()).toBe(
      '2',
    );
  });

  it('still validates when the project, task or date actually changes', async () => {
    const created = await as('dev').post('/api/time-entries', {
      ...task,
      workDate: '2026-03-10',
      hours: 4,
      isBillable: true,
    });
    const id = (created.body as { entry: { id: string } }).entry.id;
    await prisma.project.update({
      where: { id: task.projectId },
      data: { endDate: new Date('2026-03-31T00:00:00.000Z') },
    });
    const other = await createProjectWithTask(prisma, { code: 'P2' });
    await prisma.project.update({ where: { id: other.project.id }, data: { isActive: false } });

    const movePastWindow = await as('dev').patch(`/api/time-entries/${id}`, {
      workDate: '2026-04-02',
    });
    const toArchived = await as('dev').patch(`/api/time-entries/${id}`, {
      projectId: other.project.id,
      taskId: other.task.id,
    });

    expect(movePastWindow.status).toBe(422);
    expect(toArchived.status).toBe(422);
    expect(
      (await prisma.timeEntry.findUniqueOrThrow({ where: { id } })).workDate
        .toISOString()
        .slice(0, 10),
    ).toBe('2026-03-10');
  });
});

describe('finding 3: the approval queue defaults to pending items', () => {
  it('forApproval=true lists only SUBMITTED unless a status is given', async () => {
    for (const [who, week, decide] of [
      ['dev', '2026-03-02', 'approve'],
      ['dev2', '2026-03-02', null],
    ] as const) {
      await as(who).post('/api/time-entries', {
        ...task,
        workDate: week,
        hours: 8,
        isBillable: true,
      });
      const sub = await as(who).post('/api/submissions', { weekStart: week });
      if (decide) {
        const id = (sub.body as { submission: { id: string } }).submission.id;
        await as('ma').post(`/api/submissions/${id}/${decide}`);
      }
    }

    const queue = await as('ma').get('/api/submissions?forApproval=true');
    const decided = await as('ma').get('/api/submissions?forApproval=true&status=APPROVED');

    const statuses = (r: request.Response) =>
      (r.body as { submissions: { status: string }[] }).submissions.map((s) => s.status);
    expect(statuses(queue)).toEqual(['SUBMITTED']);
    expect(statuses(decided)).toEqual(['APPROVED']);
  });
});

describe('finding 4: extreme dates are 400, never 500', () => {
  it.each([
    ['entries range at year 0', '/api/time-entries?from=0000-01-01&to=0000-12-31'],
    ['report range at year 0', '/api/reports/hours?from=0000-01-01&to=0000-12-31&groupBy=month'],
    ['timesheet at year 9999', '/api/timesheets/9999-12-27'],
    ['timesheet at year 1999', '/api/timesheets/1999-12-27'],
  ])('GET %s', async (_label, path) => {
    const res = await as('admin').get(path);

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('rejects out-of-range periods and entry dates', async () => {
    for (const period of ['0000-01', '9999-12', '1999-12', '2101-01']) {
      expect((await as('admin').post('/api/locked-periods', { period })).status).toBe(400);
    }
    expect(
      (
        await as('dev').post('/api/time-entries', {
          ...task,
          workDate: '9999-12-31',
          hours: 1,
          isBillable: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await as('dev').post('/api/time-entries', {
          ...task,
          workDate: '0000-01-01',
          hours: 1,
          isBillable: true,
        })
      ).status,
    ).toBe(400);
    expect(await prisma.lockedPeriod.count()).toBe(0);
    expect(await prisma.timeEntry.count()).toBe(0);
  });

  it('still accepts the supported boundary years', async () => {
    expect((await as('admin').get('/api/time-entries?from=2000-01-01&to=2000-12-31')).status).toBe(
      200,
    );
    expect((await as('admin').post('/api/locked-periods', { period: '2100-12' })).status).toBe(201);
  });
});

describe('finding 6: documented contract matches behaviour', () => {
  it('rejects unknown fields on login too', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'dev@t.dev', password: 'x', admin: true });

    expect(res.status).toBe(400);
  });

  it('answers an out-of-scope userId filter on submissions with 404, like the other endpoints', async () => {
    expect((await as('dev').get(`/api/submissions?userId=${ids.dev2}`)).status).toBe(404);
    expect((await as('mb').get(`/api/submissions?userId=${ids.dev}`)).status).toBe(404);
    expect((await as('ma').get(`/api/submissions?userId=${ids.dev}`)).status).toBe(200);
    expect((await as('admin').get(`/api/submissions?userId=${ids.dev}`)).status).toBe(200);
  });
});

describe('finding 7: a week is never submitted to someone who can never decide it', () => {
  it.each([
    [
      'an admin',
      () => prisma.user.update({ where: { id: ids.dev }, data: { managerId: ids.admin } }),
    ],
    [
      'a plain contributor',
      () => prisma.user.update({ where: { id: ids.dev }, data: { managerId: ids.dev2 } }),
    ],
    [
      'a deactivated manager',
      () => prisma.user.update({ where: { id: ids.ma }, data: { isActive: false } }),
    ],
  ])('routes to an admin when the assigned manager is %s', async (_label, arrange) => {
    await as('dev').post('/api/time-entries', {
      ...task,
      workDate: '2026-03-10',
      hours: 4,
      isBillable: true,
    });
    await arrange();

    const res = await as('dev').post('/api/submissions', { weekStart: '2026-03-09' });

    expect(res.status).toBe(201);
    const id = (res.body as { submission: { id: string } }).submission.id;
    expect((await as('admin').post(`/api/submissions/${id}/approve`, {})).status).toBe(200);
  });

  it('refuses (422) and leaves the week editable when no manager or other admin can decide', async () => {
    await as('dev').post('/api/time-entries', {
      ...task,
      workDate: '2026-03-10',
      hours: 4,
      isBillable: true,
    });
    await prisma.user.update({ where: { id: ids.ma }, data: { isActive: false } });
    await prisma.user.update({ where: { id: ids.admin }, data: { isActive: false } });

    const res = await as('dev').post('/api/submissions', { weekStart: '2026-03-09' });

    expect(res.status).toBe(422);
    expect(await prisma.weeklySubmission.count()).toBe(0);
    expect(await prisma.auditLog.count()).toBe(0);
    expect(
      (
        await as('dev').post('/api/time-entries', {
          ...task,
          workDate: '2026-03-10',
          hours: 1,
          isBillable: true,
        })
      ).status,
    ).toBe(201);
  });
});

describe('finding 8: the database health check records why it failed', () => {
  it('reports the cause to the logger without exposing it to the client', async () => {
    const onError = vi.fn();
    const failing = {
      $queryRaw: () => Promise.reject(new Error('password authentication failed')),
    };

    const result = await getDatabaseHealth(failing as never, onError);

    expect(result).toEqual({ status: 'unavailable', database: 'down' });
    expect(onError).toHaveBeenCalledOnce();
    expect(String(onError.mock.calls[0]?.[0])).toContain('password authentication failed');
  });
});
