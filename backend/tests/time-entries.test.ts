import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createProjectWithTask,
  createTestPrisma,
  createUser,
  date,
  loginToken,
  resetDatabase,
  type ApiErrorBody,
} from './helpers.js';

const prisma = createTestPrisma();
const app = buildTestApp(prisma);

// 2026-03-02 is a Monday.
const MON = '2026-03-02';
const TUE = '2026-03-03';

interface Ctx {
  cookies: Record<string, string>;
  ids: Record<'ma' | 'mb' | 'dev' | 'dev2' | 'devb' | 'admin', string>;
  p1: { projectId: string; taskId: string };
  p2: { projectId: string; taskId: string };
}
let ctx: Ctx;

interface EntryResponse {
  entry: { id: string; userId: string; workDate: string; hours: number; isBillable: boolean };
  warnings: { code: string }[];
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const managerA = await createUser(prisma, { email: 'ma@t.dev', role: 'MANAGER' });
  const managerB = await createUser(prisma, { email: 'mb@t.dev', role: 'MANAGER' });
  const dev = await createUser(prisma, { email: 'dev@t.dev', managerId: managerA.id });
  const dev2 = await createUser(prisma, { email: 'dev2@t.dev', managerId: managerA.id });
  const devB = await createUser(prisma, { email: 'devb@t.dev', managerId: managerB.id });
  const admin = await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
  const a = await createProjectWithTask(prisma, { code: 'P1', taskName: 'T1' });
  const b = await createProjectWithTask(prisma, { code: 'P2', taskName: 'T2' });
  const cookies: Record<string, string> = {};
  for (const who of ['ma', 'mb', 'dev', 'dev2', 'devb', 'admin']) {
    cookies[who] = await loginToken(app, `${who}@t.dev`);
  }
  ctx = {
    cookies,
    ids: {
      ma: managerA.id,
      mb: managerB.id,
      dev: dev.id,
      dev2: dev2.id,
      devb: devB.id,
      admin: admin.id,
    },
    p1: { projectId: a.project.id, taskId: a.task.id },
    p2: { projectId: b.project.id, taskId: b.task.id },
  };
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const as = (who: string) => ({
  get: (path: string) => request(app).get(path).set('Cookie', ctx.cookies[who]!),
  post: (path: string, body?: object) =>
    request(app).post(path).set('Cookie', ctx.cookies[who]!).send(body),
  patch: (path: string, body?: object) =>
    request(app).patch(path).set('Cookie', ctx.cookies[who]!).send(body),
  del: (path: string) => request(app).delete(path).set('Cookie', ctx.cookies[who]!),
});

const body = (overrides: Record<string, unknown> = {}) => ({
  ...ctx.p1,
  workDate: MON,
  hours: 8,
  isBillable: true,
  ...overrides,
});
const errorOf = (res: request.Response) => (res.body as ApiErrorBody).error;
const entryCount = () => prisma.timeEntry.count();

async function log(who: string, overrides: Record<string, unknown> = {}) {
  const res = await as(who).post('/api/time-entries', body(overrides));
  expect(res.status).toBe(201);
  return (res.body as EntryResponse).entry;
}

describe('POST /api/time-entries', () => {
  it('creates an entry owned by the caller', async () => {
    const res = await as('dev').post(
      '/api/time-entries',
      body({ hours: 7.5, isBillable: false, notes: 'standup' }),
    );

    expect(res.status).toBe(201);
    const result = res.body as EntryResponse;
    expect(result.entry).toMatchObject({
      userId: ctx.ids.dev,
      workDate: MON,
      hours: 7.5,
      isBillable: false,
    });
    expect(result.warnings).toEqual([]);
  });

  it('requires authentication', async () => {
    expect((await request(app).post('/api/time-entries').send(body())).status).toBe(401);
  });

  it('ignores any attempt to set another owner (unknown field rejected)', async () => {
    const res = await as('dev').post('/api/time-entries', body({ userId: ctx.ids.dev2 }));

    expect(res.status).toBe(400);
    expect(await entryCount()).toBe(0);
  });

  it.each([
    ['zero hours', { hours: 0 }],
    ['more than 24 hours', { hours: 25 }],
    ['not a quarter hour', { hours: 1.1 }],
    ['negative hours', { hours: -1 }],
    ['non-existent date', { workDate: '2026-02-30' }],
    ['wrong date format', { workDate: '02/03/2026' }],
    ['notes too long', { notes: 'x'.repeat(1001) }],
    ['billable not boolean', { isBillable: 'yes' }],
    ['missing taskId', { taskId: undefined }],
  ])('rejects invalid input: %s', async (_label, overrides) => {
    const res = await as('dev').post('/api/time-entries', body(overrides));

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    expect(await entryCount()).toBe(0);
  });

  it('rejects a task that belongs to another project (422)', async () => {
    const res = await as('dev').post('/api/time-entries', body({ taskId: ctx.p2.taskId }));

    expect(res.status).toBe(422);
  });

  it('rejects an unknown project (404), archived project and archived task (422)', async () => {
    expect(
      (
        await as('dev').post(
          '/api/time-entries',
          body({ projectId: '11111111-1111-4111-8111-111111111111' }),
        )
      ).status,
    ).toBe(404);

    await prisma.task.update({ where: { id: ctx.p1.taskId }, data: { isActive: false } });
    expect((await as('dev').post('/api/time-entries', body())).status).toBe(422);
    await prisma.task.update({ where: { id: ctx.p1.taskId }, data: { isActive: true } });

    await prisma.project.update({ where: { id: ctx.p1.projectId }, data: { isActive: false } });
    expect((await as('dev').post('/api/time-entries', body())).status).toBe(422);
    expect(await entryCount()).toBe(0);
  });

  it('rejects a date outside the project’s start/end window (422)', async () => {
    await prisma.project.update({
      where: { id: ctx.p1.projectId },
      data: { startDate: date('2026-03-03'), endDate: date('2026-03-31') },
    });

    expect((await as('dev').post('/api/time-entries', body({ workDate: MON }))).status).toBe(422);
    expect((await as('dev').post('/api/time-entries', body({ workDate: TUE }))).status).toBe(201);
    expect(
      (await as('dev').post('/api/time-entries', body({ workDate: '2026-04-01' }))).status,
    ).toBe(422);
  });
});

describe('daily and weekly hour rules', () => {
  it('allows exactly 24 hours in a day and rejects anything beyond (422, nothing saved)', async () => {
    await log('dev', { hours: 12 });
    await log('dev', { hours: 12 });

    const res = await as('dev').post('/api/time-entries', body({ hours: 0.25 }));

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('DAILY_LIMIT_EXCEEDED');
    expect(await entryCount()).toBe(2);
  });

  it('counts the limit per user and per day', async () => {
    await log('dev', { hours: 24 });

    expect((await as('dev2').post('/api/time-entries', body({ hours: 24 }))).status).toBe(201);
    expect(
      (await as('dev').post('/api/time-entries', body({ workDate: TUE, hours: 24 }))).status,
    ).toBe(201);
  });

  it('warns (without blocking) above 10 hours in a day', async () => {
    const res = await as('dev').post('/api/time-entries', body({ hours: 11 }));

    expect(res.status).toBe(201);
    expect((res.body as EntryResponse).warnings.map((w) => w.code)).toEqual(['DAILY_HOURS_HIGH']);
  });

  it('warns above 48 hours in a week', async () => {
    for (const day of ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06']) {
      await log('dev', { workDate: day, hours: 9.5 });
    }

    const res = await as('dev').post(
      '/api/time-entries',
      body({ workDate: '2026-03-07', hours: 4 }),
    );

    expect(res.status).toBe(201);
    expect((res.body as EntryResponse).warnings.map((w) => w.code)).toEqual(['WEEKLY_HOURS_HIGH']);
  });

  it('keeps the daily limit under concurrent requests (no read-then-write race)', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => as('dev').post('/api/time-entries', body({ hours: 8 }))),
    );

    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(3); // 3 x 8h = 24h
    expect(statuses.filter((s) => s === 422)).toHaveLength(5);
    const total = await prisma.timeEntry.aggregate({ _sum: { hours: true } });
    expect(Number(total._sum.hours)).toBe(24);
  });
});

describe('reading entries', () => {
  it('lets the owner, their manager and an admin read an entry, but nobody else', async () => {
    const entry = await log('dev');
    const path = `/api/time-entries/${entry.id}`;

    expect((await as('dev').get(path)).status).toBe(200);
    expect((await as('ma').get(path)).status).toBe(200);
    expect((await as('admin').get(path)).status).toBe(200);
    expect((await as('mb').get(path)).status).toBe(404);
    expect((await as('dev2').get(path)).status).toBe(404);
    expect((await as('devb').get(path)).status).toBe(404);
    expect((await request(app).get(path)).status).toBe(401);
  });

  it('lists only the caller’s own entries by default, filtered by date range', async () => {
    await log('dev', { workDate: MON });
    await log('dev', { workDate: '2026-04-06' });
    await log('dev2', { workDate: MON });

    const res = await as('dev').get(`/api/time-entries?from=${MON}&to=2026-03-31`);

    const entries = (res.body as { entries: EntryResponse['entry'][] }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: ctx.ids.dev, workDate: MON });
  });

  it('scopes the userId filter: managers see reports, contributors and other managers get 404', async () => {
    await log('dev');
    const q = `from=${MON}&to=${MON}&userId=${ctx.ids.dev}`;

    expect((await as('ma').get(`/api/time-entries?${q}`)).status).toBe(200);
    expect((await as('admin').get(`/api/time-entries?${q}`)).status).toBe(200);
    expect((await as('mb').get(`/api/time-entries?${q}`)).status).toBe(404);
    expect((await as('dev2').get(`/api/time-entries?${q}`)).status).toBe(404);
  });

  it('validates the range', async () => {
    expect((await as('dev').get(`/api/time-entries?from=${TUE}&to=${MON}`)).status).toBe(400);
    expect((await as('dev').get('/api/time-entries?from=2025-01-01&to=2026-12-31')).status).toBe(
      400,
    );
    expect((await as('dev').get('/api/time-entries')).status).toBe(400);
  });

  it('answers an impossible or malformed date with 400, never 500 (regression)', async () => {
    for (const q of [
      'from=2026-02-30&to=2026-03-31',
      'from=2026-03-01&to=2026-02-30',
      'from=2026-03-01&to=nope',
      'from=&to=',
    ]) {
      const res = await as('dev').get(`/api/time-entries?${q}`);
      expect(res.status).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('PATCH /api/time-entries/:id', () => {
  it('updates fields and enforces the daily limit excluding the entry itself', async () => {
    const first = await log('dev', { hours: 12 });
    await log('dev', { hours: 12 });

    const same = await as('dev').patch(`/api/time-entries/${first.id}`, {
      hours: 12,
      isBillable: false,
    });
    expect(same.status).toBe(200);
    expect((same.body as EntryResponse).entry).toMatchObject({ hours: 12, isBillable: false });

    const tooMuch = await as('dev').patch(`/api/time-entries/${first.id}`, { hours: 12.25 });
    expect(tooMuch.status).toBe(422);
    expect(
      (await prisma.timeEntry.findUniqueOrThrow({ where: { id: first.id } })).hours.toString(),
    ).toBe('12');
  });

  it('can move an entry to another day (limit applies to the new day)', async () => {
    await log('dev', { workDate: TUE, hours: 24 });
    const entry = await log('dev', { workDate: MON, hours: 1 });

    const blocked = await as('dev').patch(`/api/time-entries/${entry.id}`, { workDate: TUE });
    expect(blocked.status).toBe(422);

    const ok = await as('dev').patch(`/api/time-entries/${entry.id}`, { workDate: '2026-03-04' });
    expect((ok.body as EntryResponse).entry.workDate).toBe('2026-03-04');
  });

  it('requires taskId when changing the project, and revalidates the pair', async () => {
    const entry = await log('dev');

    expect(
      (await as('dev').patch(`/api/time-entries/${entry.id}`, { projectId: ctx.p2.projectId }))
        .status,
    ).toBe(400);
    expect(
      (
        await as('dev').patch(`/api/time-entries/${entry.id}`, {
          projectId: ctx.p2.projectId,
          taskId: ctx.p1.taskId,
        })
      ).status,
    ).toBe(422);
    expect((await as('dev').patch(`/api/time-entries/${entry.id}`, ctx.p2)).status).toBe(200);
  });

  it('rejects an empty patch', async () => {
    const entry = await log('dev');

    expect((await as('dev').patch(`/api/time-entries/${entry.id}`, {})).status).toBe(400);
  });

  it('is refused for everyone but the owner: 403 if you may see it, 404 if not; data unchanged', async () => {
    const entry = await log('dev', { hours: 8 });
    const path = `/api/time-entries/${entry.id}`;

    expect((await as('ma').patch(path, { hours: 1 })).status).toBe(403);
    expect((await as('admin').patch(path, { hours: 1 })).status).toBe(403);
    expect((await as('dev2').patch(path, { hours: 1 })).status).toBe(404);
    expect((await as('mb').patch(path, { hours: 1 })).status).toBe(404);
    expect((await request(app).patch(path).send({ hours: 1 })).status).toBe(401);

    expect(
      (await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).hours.toString(),
    ).toBe('8');
  });
});

describe('DELETE /api/time-entries/:id', () => {
  it('lets the owner delete', async () => {
    const entry = await log('dev');

    expect((await as('dev').del(`/api/time-entries/${entry.id}`)).status).toBe(204);
    expect((await as('dev').get(`/api/time-entries/${entry.id}`)).status).toBe(404);
  });

  it('is refused for non-owners and anonymous callers; the entry survives', async () => {
    const entry = await log('dev');
    const path = `/api/time-entries/${entry.id}`;

    expect((await as('ma').del(path)).status).toBe(403);
    expect((await as('admin').del(path)).status).toBe(403);
    expect((await as('dev2').del(path)).status).toBe(404);
    expect((await as('mb').del(path)).status).toBe(404);
    expect((await request(app).delete(path)).status).toBe(401);
    expect(await entryCount()).toBe(1);
  });
});

describe('GET /api/timesheets/:weekStart', () => {
  it('summarizes the week with totals, billable split and DRAFT status', async () => {
    await log('dev', { workDate: MON, hours: 8, isBillable: true });
    await log('dev', { workDate: MON, hours: 1.5, isBillable: false });
    await log('dev', { workDate: TUE, hours: 6, isBillable: true });
    await log('dev', { workDate: '2026-03-09', hours: 8 }); // next week

    const res = await as('dev').get(`/api/timesheets/${MON}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      weekStart: MON,
      weekEnd: '2026-03-08',
      status: 'DRAFT',
      weeklyTotal: 15.5,
      billableTotal: 14,
      nonBillableTotal: 1.5,
      dailyTotals: { [MON]: 9.5, [TUE]: 6 },
    });
    expect((res.body as { entries: unknown[] }).entries).toHaveLength(3);
  });

  it('requires a Monday', async () => {
    expect((await as('dev').get(`/api/timesheets/${TUE}`)).status).toBe(400);
  });

  it('scopes the userId option like the entry list', async () => {
    await log('dev');

    expect((await as('ma').get(`/api/timesheets/${MON}?userId=${ctx.ids.dev}`)).status).toBe(200);
    expect((await as('mb').get(`/api/timesheets/${MON}?userId=${ctx.ids.dev}`)).status).toBe(404);
    expect((await as('dev2').get(`/api/timesheets/${MON}?userId=${ctx.ids.dev}`)).status).toBe(404);
  });
});
