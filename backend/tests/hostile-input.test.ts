import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createProjectWithTask,
  createTestPrisma,
  createUser,
  loginToken,
  resetDatabase,
  type ApiErrorBody,
} from './helpers.js';

// Regression tests for hostile input found by probing the live API (Phase 9): nothing a client
// sends may produce a 500.
const prisma = createTestPrisma();
const app = buildTestApp(prisma);

type Who = 'admin' | 'ma' | 'dev';
let cookies: Record<Who, string>;
let task: { projectId: string; taskId: string };
let submissionId: string;

beforeEach(async () => {
  await resetDatabase(prisma);
  await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
  const ma = await createUser(prisma, { email: 'ma@t.dev', role: 'MANAGER' });
  const dev = await createUser(prisma, { email: 'dev@t.dev', managerId: ma.id });
  const { project, task: t } = await createProjectWithTask(prisma, { code: 'P1' });
  task = { projectId: project.id, taskId: t.id };
  cookies = {} as Record<Who, string>;
  for (const who of ['admin', 'ma', 'dev'] as const)
    cookies[who] = await loginToken(app, `${who}@t.dev`);
  // A real submission, so decisions reach the database layer (not a 404 on an unknown id).
  await prisma.timeEntry.create({
    data: {
      userId: dev.id,
      projectId: task.projectId,
      taskId: task.taskId,
      workDate: new Date('2040-03-05T00:00:00Z'),
      hours: 1,
      isBillable: true,
    },
  });
  const sub = await request(app)
    .post('/api/submissions')
    .set('Cookie', cookies.dev)
    .send({ weekStart: '2040-03-05' });
  expect(sub.status).toBe(201); // the fixture must be real, or the NUL tests would not reach the database layer
  submissionId = (sub.body as { submission?: { id: string } }).submission?.id ?? '';
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const as = (who: Who) => ({
  post: (path: string, body?: object | string) =>
    request(app)
      .post(path)
      .set('Cookie', cookies[who])
      .set('Content-Type', 'application/json')
      .send(body),
  patch: (path: string, body?: object) =>
    request(app).patch(path).set('Cookie', cookies[who]).send(body),
  get: (path: string) => request(app).get(path).set('Cookie', cookies[who]),
});
const errorOf = (res: request.Response) => (res.body as ApiErrorBody).error;

describe('NUL characters never reach the database', () => {
  const NUL = 'a\u0000b';

  it.each([
    [
      'entry notes',
      () =>
        as('dev').post('/api/time-entries', {
          ...task,
          workDate: '2040-03-06',
          hours: 1,
          isBillable: true,
          notes: NUL,
        }),
    ],
    [
      'project name',
      () => as('admin').post('/api/projects', { code: 'N1', name: NUL, budgetHours: 1 }),
    ],
    [
      'project client',
      () =>
        as('admin').post('/api/projects', {
          code: 'N2',
          name: 'n',
          clientName: NUL,
          budgetHours: 1,
        }),
    ],
    ['task name', () => as('admin').post(`/api/projects/${task.projectId}/tasks`, { name: NUL })],
    ['lock note', () => as('admin').post('/api/locked-periods', { period: '2041-03', note: NUL })],
    [
      'unlock reason',
      () => as('admin').post('/api/locked-periods/2041-03/unlock', { reason: NUL }),
    ],
    [
      'reject comment',
      () => as('ma').post(`/api/submissions/${submissionId}/reject`, { comment: NUL }),
    ],
    [
      'approve comment',
      () => as('ma').post(`/api/submissions/${submissionId}/approve`, { comment: NUL }),
    ],
    [
      'nested value',
      () =>
        as('dev').post('/api/time-entries', {
          ...task,
          workDate: '2040-03-06',
          hours: 1,
          isBillable: true,
          extra: { deep: [NUL] },
        }),
    ],
    ['object key', () => as('dev').post('/api/time-entries', '{"a\\u0000b": 1}')],
    ['login email', () => request(app).post('/api/auth/login').send({ email: NUL, password: 'x' })],
  ])('%s -> 400, not 500', async (_label, send) => {
    const res = await send();

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('rejects an encoded NUL in a path or query string', async () => {
    expect((await as('admin').get('/api/projects/%00')).status).toBe(400);
    expect((await as('admin').get('/api/audit-logs?entityId=%00')).status).toBe(400);
    expect(
      (await as('admin').post('/api/locked-periods/%00/unlock', { reason: 'abcd' })).status,
    ).toBe(400);
  });

  it('left no partial data behind', async () => {
    await as('admin').post('/api/projects', { code: 'N3', name: NUL, budgetHours: 1 });

    expect(await prisma.project.count({ where: { code: 'N3' } })).toBe(0);
  });

  it('still accepts normal text, including unicode and emoji', async () => {
    const res = await as('dev').post('/api/time-entries', {
      ...task,
      workDate: '2040-03-14',
      hours: 1,
      isBillable: true,
      notes: 'Réunion équipe 😀 日本語',
    });

    expect(res.status).toBe(201);
  });
});

describe('other hostile payloads are 4xx, never 5xx', () => {
  it.each([
    ['array body', '[]'],
    ['string body', '"hello"'],
    ['null body', 'null'],
    ['number body', '42'],
    [
      'prototype pollution keys',
      '{"__proto__":{"admin":true},"constructor":{"prototype":{"x":1}}}',
    ],
    ['deeply nested arrays', '['.repeat(4000) + ']'.repeat(4000)],
    ['invalid JSON', '{"a":'],
  ])('%s', async (_label, raw) => {
    const res = await as('dev').post('/api/time-entries', raw);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it.each([
    ['hours 1e308', { hours: 1e308 }],
    ['hours as string', { hours: '8' }],
    ['date year 0', { workDate: '0000-01-01' }],
    ['date year 9999', { workDate: '9999-12-31' }],
    ['project id as SQL', { projectId: "'; DROP TABLE users;--" }],
    ['10 000-char notes', { notes: 'x'.repeat(10_000) }],
    ['bidi/control chars in notes', { notes: '‮⁦ text' }],
  ])('entry with %s', async (_label, override) => {
    const res = await as('dev').post('/api/time-entries', {
      ...task,
      workDate: '2040-03-08',
      hours: 1,
      isBillable: true,
      ...override,
    });

    expect(res.status).toBeLessThan(500);
  });

  it('survives garbage credentials and odd query strings', async () => {
    const garbage = await request(app).get('/api/auth/me').set('Cookie', 'at=%E0%A4%A; ;;;=');
    const arrays = await as('admin').get(
      '/api/reports/hours?from[]=x&to=2040-01-01&groupBy=month&groupBy=project',
    );

    expect(garbage.status).toBe(401);
    expect(arrays.status).toBe(400);
  });
});
