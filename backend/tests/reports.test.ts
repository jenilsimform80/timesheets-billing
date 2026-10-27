import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthUser } from '../src/auth/auth-user.js';
import { getHoursReport, budgetStatus } from '../src/services/report.service.js';
import type { ReportDimension } from '../src/validation/reports.schemas.js';
import {
  buildTestApp,
  createTestPrisma,
  createUser,
  date,
  loginToken,
  resetDatabase,
  type ApiErrorBody,
} from './helpers.js';

const prisma = createTestPrisma();
const app = buildTestApp(prisma);

type Who = 'admin' | 'ma' | 'mb' | 'devA' | 'devB' | 'devC';
const cookies = {} as Record<Who, string>;
const ids = {} as Record<Who, string>;
const names: Record<string, string> = {};
const projectIds: Record<string, string> = {};
const projectNames: Record<string, string> = {};

interface Seed {
  who: Who;
  project: 'P1' | 'P2' | 'P4';
  day: string;
  hours: number;
  billable: boolean;
}
// Month boundaries on purpose: 02-27/03-01 and 03-31/04-01. P4 is archived but has history.
const SEED: Seed[] = [
  { who: 'devA', project: 'P1', day: '2026-02-27', hours: 4, billable: true },
  { who: 'devA', project: 'P1', day: '2026-03-01', hours: 2, billable: false },
  { who: 'devA', project: 'P1', day: '2026-03-10', hours: 8, billable: true },
  { who: 'devA', project: 'P2', day: '2026-03-10', hours: 1.5, billable: true },
  { who: 'devA', project: 'P2', day: '2026-04-01', hours: 3, billable: true },
  { who: 'devB', project: 'P1', day: '2026-03-10', hours: 5, billable: true },
  { who: 'devB', project: 'P2', day: '2026-03-31', hours: 2, billable: false },
  { who: 'devC', project: 'P1', day: '2026-03-15', hours: 6, billable: true },
  { who: 'devC', project: 'P4', day: '2026-03-20', hours: 7.25, billable: false },
];
// Reporting lines: ma -> devA, devB; mb -> devC.
const REPORTS_OF: Record<Who, Who[]> = {
  admin: [],
  ma: ['devA', 'devB'],
  mb: ['devC'],
  devA: [],
  devB: [],
  devC: [],
};
const visibleTo = (viewer: Who): Who[] =>
  viewer === 'admin'
    ? ['admin', 'ma', 'mb', 'devA', 'devB', 'devC']
    : [viewer, ...REPORTS_OF[viewer]];

beforeAll(async () => {
  await resetDatabase(prisma);
  const admin = await createUser(prisma, {
    email: 'admin@t.dev',
    role: 'ADMIN',
    name: 'Alex Admin',
  });
  const ma = await createUser(prisma, { email: 'ma@t.dev', role: 'MANAGER', name: 'Mia Manager' });
  const mb = await createUser(prisma, { email: 'mb@t.dev', role: 'MANAGER', name: 'Max Manager' });
  const devA = await createUser(prisma, { email: 'a@t.dev', name: 'Ann Dev', managerId: ma.id });
  const devB = await createUser(prisma, { email: 'b@t.dev', name: 'Bob Dev', managerId: ma.id });
  const devC = await createUser(prisma, { email: 'c@t.dev', name: 'Cy Dev', managerId: mb.id });
  Object.assign(ids, {
    admin: admin.id,
    ma: ma.id,
    mb: mb.id,
    devA: devA.id,
    devB: devB.id,
    devC: devC.id,
  });
  for (const [who, id] of Object.entries(ids)) names[id] = who;
  const emails: Record<Who, string> = {
    admin: 'admin',
    ma: 'ma',
    mb: 'mb',
    devA: 'a',
    devB: 'b',
    devC: 'c',
  };
  for (const who of Object.keys(emails) as Who[])
    cookies[who] = await loginToken(app, `${emails[who]}@t.dev`);

  const budgets = { P1: 40, P2: 10, P3: 0, P4: 100 } as const;
  for (const code of ['P1', 'P2', 'P3', 'P4'] as const) {
    const project = await prisma.project.create({
      data: { code, name: `Project ${code}`, budgetHours: budgets[code], isActive: code !== 'P4' },
    });
    projectIds[code] = project.id;
    projectNames[project.id] = `Project ${code}`;
    await prisma.task.create({ data: { projectId: project.id, name: 'Work' } });
  }
  for (const row of SEED) {
    const task = await prisma.task.findFirstOrThrow({
      where: { projectId: projectIds[row.project]! },
    });
    await prisma.timeEntry.create({
      data: {
        userId: ids[row.who],
        projectId: projectIds[row.project]!,
        taskId: task.id,
        workDate: date(row.day),
        hours: row.hours,
        isBillable: row.billable,
      },
    });
  }
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const as = (who: Who) => ({
  get: (path: string) => request(app).get(path).set('Cookie', cookies[who]),
});
const errorOf = (res: request.Response) => (res.body as ApiErrorBody).error;

/** Independent oracle: aggregate the seed in plain JS (the code under test uses SQL). */
function oracle(opts: {
  viewer: Who;
  from: string;
  to: string;
  groupBy: ReportDimension[];
  user?: Who;
  project?: string;
}) {
  const allowed = new Set(visibleTo(opts.viewer));
  const groups = new Map<
    string,
    { key: Record<string, string>; total: number; billable: number; count: number }
  >();
  for (const e of SEED) {
    if (!allowed.has(e.who) || e.day < opts.from || e.day > opts.to) continue;
    if (opts.user && e.who !== opts.user) continue;
    if (opts.project && e.project !== opts.project) continue;
    const key: Record<string, string> = {};
    if (opts.groupBy.includes('contributor')) key['userId'] = ids[e.who];
    if (opts.groupBy.includes('project')) key['projectId'] = projectIds[e.project]!;
    if (opts.groupBy.includes('month')) key['month'] = e.day.slice(0, 7);
    const id = JSON.stringify(key);
    const g = groups.get(id) ?? { key, total: 0, billable: 0, count: 0 };
    g.total += e.hours;
    if (e.billable) g.billable += e.hours;
    g.count += 1;
    groups.set(id, g);
  }
  return [...groups.values()].map((g) => ({
    ...g.key,
    totalHours: g.total,
    billableHours: g.billable,
    nonBillableHours: g.total - g.billable,
    entryCount: g.count,
  }));
}

interface HoursBody {
  rows: Record<string, unknown>[];
  totals: {
    totalHours: number;
    billableHours: number;
    nonBillableHours: number;
    entryCount: number;
  };
  truncated: boolean;
}
const hours = async (who: Who, q: string) => {
  const res = await as(who).get(`/api/reports/hours?${q}`);
  return { res, body: res.body as HoursBody };
};
const keyOf = (row: Record<string, unknown>) =>
  JSON.stringify([row['userId'], row['projectId'], row['month']]);
const pick = (rows: Record<string, unknown>[]) =>
  rows
    .map((r) => ({
      ...(r['userId'] !== undefined && { userId: r['userId'] }),
      ...(r['projectId'] !== undefined && { projectId: r['projectId'] }),
      ...(r['month'] !== undefined && { month: r['month'] }),
      totalHours: r['totalHours'],
      billableHours: r['billableHours'],
      nonBillableHours: r['nonBillableHours'],
      entryCount: r['entryCount'],
    }))
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
const sorted = (rows: ReturnType<typeof oracle>) =>
  rows.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));

describe('GET /api/reports/hours: known values', () => {
  it('totals hours by month with a billable split (hand-checked)', async () => {
    const { res, body } = await hours('admin', 'from=2026-02-01&to=2026-04-30&groupBy=month');

    expect(res.status).toBe(200);
    expect(body.rows).toEqual([
      { month: '2026-02', totalHours: 4, billableHours: 4, nonBillableHours: 0, entryCount: 1 },
      {
        month: '2026-03',
        totalHours: 31.75, // 2 + 8 + 1.5 + 5 + 2 + 6 + 7.25
        billableHours: 20.5, // 8 + 1.5 + 5 + 6
        nonBillableHours: 11.25, // 2 + 2 + 7.25
        entryCount: 7,
      },
      { month: '2026-04', totalHours: 3, billableHours: 3, nonBillableHours: 0, entryCount: 1 },
    ]);
    expect(body.totals).toEqual({
      totalHours: 38.75, // 4 + 31.75 + 3
      billableHours: 27.5,
      nonBillableHours: 11.25,
      entryCount: 9,
    });
    expect(body.truncated).toBe(false);
  });

  it('totals hours by contributor and by project (hand-checked)', async () => {
    const byUser = await hours('admin', 'from=2026-02-01&to=2026-04-30&groupBy=contributor');
    expect(byUser.body.rows.map((r) => [r['userName'], r['totalHours']])).toEqual([
      ['Ann Dev', 18.5],
      ['Bob Dev', 7],
      ['Cy Dev', 13.25],
    ]);

    const byProject = await hours('admin', 'from=2026-02-01&to=2026-04-30&groupBy=project');
    expect(
      byProject.body.rows.map((r) => [r['projectCode'], r['totalHours'], r['billableHours']]),
    ).toEqual([
      ['P1', 25, 23],
      ['P2', 6.5, 4.5],
      ['P4', 7.25, 0],
    ]);
  });

  it('includes both range ends (single day, month boundaries)', async () => {
    const single = await hours('admin', 'from=2026-03-10&to=2026-03-10&groupBy=month');
    expect(single.body.totals.totalHours).toBe(14.5);

    const marchOnly = await hours('admin', 'from=2026-03-01&to=2026-03-31&groupBy=month');
    expect(marchOnly.body.rows).toHaveLength(1);
    expect(marchOnly.body.totals.entryCount).toBe(7); // 03-01 and 03-31 both included
  });

  it('returns no rows for an empty range', async () => {
    const { body } = await hours('admin', 'from=2025-01-01&to=2025-01-31&groupBy=month');

    expect(body.rows).toEqual([]);
    expect(body.totals.totalHours).toBe(0);
  });

  it('applies the userId and projectId filters', async () => {
    const byUser = await hours(
      'admin',
      `from=2026-02-01&to=2026-04-30&groupBy=project&userId=${ids.devA}`,
    );
    expect(byUser.body.totals.totalHours).toBe(18.5);

    const byProject = await hours(
      'admin',
      `from=2026-02-01&to=2026-04-30&groupBy=contributor&projectId=${projectIds.P2}`,
    );
    expect(byProject.body.rows.map((r) => [r['userName'], r['totalHours']])).toEqual([
      ['Ann Dev', 4.5],
      ['Bob Dev', 2],
    ]);
  });
});

describe('GET /api/reports/hours: every grouping, every role, against an independent oracle', () => {
  const groupings: ReportDimension[][] = [
    ['contributor'],
    ['project'],
    ['month'],
    ['contributor', 'project'],
    ['contributor', 'month'],
    ['project', 'month'],
    ['contributor', 'project', 'month'],
    ['month', 'contributor'], // order of the request must not matter
  ];
  const viewers: Who[] = ['admin', 'ma', 'mb', 'devA', 'devC'];

  for (const viewer of viewers) {
    it(`matches for ${viewer} across all groupings`, async () => {
      for (const groupBy of groupings) {
        const from = '2026-02-01';
        const to = '2026-04-30';
        const { res, body } = await hours(
          viewer,
          `from=${from}&to=${to}&groupBy=${groupBy.join(',')}`,
        );

        expect(res.status).toBe(200);
        expect(pick(body.rows)).toEqual(sorted(oracle({ viewer, from, to, groupBy })));
      }
    });
  }
});

describe('GET /api/reports/hours: visibility', () => {
  it('shows contributors only their own hours, managers their team, admins everyone', async () => {
    const q = 'from=2026-02-01&to=2026-04-30&groupBy=contributor';
    const names = async (who: Who) => (await hours(who, q)).body.rows.map((r) => r['userName']);

    expect(await names('devA')).toEqual(['Ann Dev']);
    expect(await names('ma')).toEqual(['Ann Dev', 'Bob Dev']);
    expect(await names('mb')).toEqual(['Cy Dev']);
    expect(await names('admin')).toEqual(['Ann Dev', 'Bob Dev', 'Cy Dev']);
  });

  it('never leaks hours of people outside the viewer’s scope into totals', async () => {
    const own = await hours('devB', 'from=2026-02-01&to=2026-04-30&groupBy=month');

    expect(own.body.totals.totalHours).toBe(7);
  });

  it('refuses a userId outside the scope with 404, and allows in-scope ids', async () => {
    const q = (id: string) => `from=2026-02-01&to=2026-04-30&groupBy=month&userId=${id}`;

    expect((await hours('devA', q(ids.devB))).res.status).toBe(404);
    expect((await hours('ma', q(ids.devC))).res.status).toBe(404);
    expect((await hours('mb', q(ids.devA))).res.status).toBe(404);
    expect((await hours('ma', q(ids.devA))).res.status).toBe(200);
    expect((await hours('devA', q(ids.devA))).res.status).toBe(200);
    expect((await hours('admin', q(ids.devC))).res.status).toBe(200);
  });

  it('requires authentication', async () => {
    expect(
      (await request(app).get('/api/reports/hours?from=2026-03-01&to=2026-03-31&groupBy=month'))
        .status,
    ).toBe(401);
  });
});

describe('GET /api/reports/hours: validation', () => {
  it.each([
    ['missing from', 'to=2026-03-31&groupBy=month'],
    ['missing groupBy', 'from=2026-03-01&to=2026-03-31'],
    ['from after to', 'from=2026-04-01&to=2026-03-01&groupBy=month'],
    ['range over 5 years', 'from=2020-01-01&to=2026-03-31&groupBy=month'],
    ['unknown dimension', 'from=2026-03-01&to=2026-03-31&groupBy=week'],
    ['repeated dimension', 'from=2026-03-01&to=2026-03-31&groupBy=month,month'],
    ['empty groupBy', 'from=2026-03-01&to=2026-03-31&groupBy='],
    ['SQL in groupBy', 'from=2026-03-01&to=2026-03-31&groupBy=month;DROP TABLE users'],
    ['non-existent from date', 'from=2026-02-30&to=2026-03-31&groupBy=month'],
    ['non-existent to date', 'from=2026-03-01&to=2026-02-30&groupBy=month'],
    ['malformed to date', 'from=2026-03-01&to=yesterday&groupBy=month'],
    ['bad userId', 'from=2026-03-01&to=2026-03-31&groupBy=month&userId=1 OR 1=1'],
  ])('rejects %s with 400', async (_label, query) => {
    const res = await as('admin').get(`/api/reports/hours?${encodeURI(query)}`);

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_ERROR');
  });

  it('left the database intact after the injection attempt', async () => {
    expect(await prisma.user.count()).toBe(6);
  });
});

describe('time zone independence (calendar dates are never shifted)', () => {
  const dims: ReportDimension[] = ['contributor', 'project', 'month'];
  const admin = (): AuthUser => ({
    id: ids.admin,
    email: 'admin@t.dev',
    name: 'Alex Admin',
    role: 'ADMIN',
    managerId: null,
    mustChangePassword: false,
  });
  const filter = { from: date('2026-02-01'), to: date('2026-04-30'), groupBy: dims };

  it.each([
    'UTC',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
    'America/Los_Angeles',
    'Asia/Kolkata',
  ])('gives identical results with the database session in %s', async (zone) => {
    const baseline = await getHoursReport(prisma, admin(), filter);
    const shifted = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${zone}'`); // constant list above, not user input
      return getHoursReport(tx, admin(), filter);
    });

    expect(shifted).toEqual(baseline);
    expect(shifted.rows.some((r) => r.month === '2026-03')).toBe(true);
  });

  it('gives identical results with the Node process in another time zone', async () => {
    const original = process.env['TZ'];
    try {
      process.env['TZ'] = 'Pacific/Auckland';
      const res = await as('admin').get(
        '/api/reports/hours?from=2026-03-31&to=2026-03-31&groupBy=month',
      );

      expect((res.body as HoursBody).totals.totalHours).toBe(2); // exactly the 03-31 entry
    } finally {
      if (original === undefined) delete process.env['TZ'];
      else process.env['TZ'] = original;
    }
  });
});

interface BudgetProject {
  code: string;
  isActive: boolean;
  budgetHours: number;
  loggedHours: number;
  billableHours: number;
  nonBillableHours: number;
  remainingHours: number;
  percentUsed: number | null;
  status: string;
}
const budgets = async (who: Who, q = '') => {
  const res = await as(who).get(`/api/reports/project-budgets${q}`);
  return { res, projects: (res.body as { projects: BudgetProject[] }).projects };
};

describe('GET /api/reports/project-budgets', () => {
  it('compares logged hours with allocated hours per project (hand-checked)', async () => {
    const { res, projects } = await budgets('admin');

    expect(res.status).toBe(200);
    expect(projects.map((p) => p.code)).toEqual(['P1', 'P2', 'P3']); // archived P4 hidden
    expect(projects[0]).toMatchObject({
      budgetHours: 40,
      loggedHours: 25,
      billableHours: 23,
      nonBillableHours: 2,
      remainingHours: 15,
      percentUsed: 62.5,
      status: 'OK',
    });
    expect(projects[1]).toMatchObject({
      budgetHours: 10,
      loggedHours: 6.5,
      percentUsed: 65,
      status: 'OK',
    });
  });

  it('lists projects with no hours and handles a zero budget', async () => {
    const { projects } = await budgets('admin');

    expect(projects[2]).toMatchObject({
      code: 'P3',
      budgetHours: 0,
      loggedHours: 0,
      remainingHours: 0,
      percentUsed: null,
      status: 'OK',
    });
  });

  it('includes archived projects only on request', async () => {
    const { projects } = await budgets('admin', '?includeArchived=true');

    expect(projects.map((p) => p.code)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(projects[3]).toMatchObject({
      isActive: false,
      loggedHours: 7.25,
      nonBillableHours: 7.25,
    });
  });

  it('supports a through-date snapshot and a project filter', async () => {
    const snapshot = await budgets('admin', '?through=2026-03-10');
    expect(snapshot.projects[0]).toMatchObject({ code: 'P1', loggedHours: 19 }); // 4+2+8+5
    expect(snapshot.projects[1]).toMatchObject({ code: 'P2', loggedHours: 1.5 });

    const one = await budgets('admin', `?projectId=${projectIds.P2}`);
    expect(one.projects.map((p) => p.code)).toEqual(['P2']);
  });

  it('is admin only', async () => {
    for (const who of ['ma', 'devA'] as const) {
      const { res } = await budgets(who);
      expect(res.status).toBe(403);
    }
    expect((await request(app).get('/api/reports/project-budgets')).status).toBe(401);
  });

  it('validates its query', async () => {
    expect((await budgets('admin', '?projectId=nope')).res.status).toBe(400);
    expect((await budgets('admin', '?through=2026-02-30')).res.status).toBe(400);
  });

  it('flags WARNING from 80% and OVER above 100% (exact boundaries)', async () => {
    expect(budgetStatus(10, 7.99)).toBe('OK');
    expect(budgetStatus(10, 8)).toBe('WARNING');
    expect(budgetStatus(10, 10)).toBe('WARNING'); // exactly on budget is not over
    expect(budgetStatus(10, 10.25)).toBe('OVER');
    expect(budgetStatus(0, 0)).toBe('OK');
    expect(budgetStatus(0, 0.25)).toBe('OVER');

    // End to end: push P2 to 8 and then past 10 hours.
    const task = await prisma.task.findFirstOrThrow({ where: { projectId: projectIds.P2! } });
    const extra = async (hoursToAdd: number, day: string) =>
      prisma.timeEntry.create({
        data: {
          userId: ids.devB,
          projectId: projectIds.P2!,
          taskId: task.id,
          workDate: date(day),
          hours: hoursToAdd,
          isBillable: true,
        },
      });
    const warn = await extra(1.5, '2026-05-04'); // 6.5 + 1.5 = 8.0
    expect((await budgets('admin')).projects[1]).toMatchObject({
      loggedHours: 8,
      percentUsed: 80,
      status: 'WARNING',
    });
    const over = await extra(2.25, '2026-05-05'); // 10.25
    expect((await budgets('admin')).projects[1]).toMatchObject({
      remainingHours: -0.25,
      status: 'OVER',
    });
    await prisma.timeEntry.deleteMany({ where: { id: { in: [warn.id, over.id] } } });
  });
});
