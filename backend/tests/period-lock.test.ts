import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { postgresErrorCode } from '../src/errors/prisma-errors.js';
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

const FEB = '2026-02-10';
const MAR = '2026-03-10';
const APR = '2026-04-10';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Who = 'admin' | 'ma' | 'dev' | 'dev2' | 'mb';
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
  for (const who of ['admin', 'ma', 'dev', 'dev2', 'mb'] as const) {
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
  del: (path: string) => request(app).delete(path).set('Cookie', cookies[who]),
});
const errorOf = (res: request.Response) => (res.body as ApiErrorBody).error;
const lock = (period: string, who: Who = 'admin', note?: string) =>
  as(who).post('/api/locked-periods', { period, ...(note && { note }) });
const unlock = (period: string, reason = 'Correction approved by finance', who: Who = 'admin') =>
  as(who).post(`/api/locked-periods/${period}/unlock`, { reason });

async function log(who: Who, workDate: string, hours = 4): Promise<string> {
  const res = await as(who).post('/api/time-entries', {
    ...task,
    workDate,
    hours,
    isBillable: true,
  });
  expect(res.status).toBe(201);
  return (res.body as { entry: { id: string } }).entry.id;
}
const hoursOf = async (id: string) =>
  (await prisma.timeEntry.findUniqueOrThrow({ where: { id } })).hours.toString();

/** Direct SQL that bypasses every line of application code. */
function rawInsert(
  db: { $executeRaw: typeof prisma.$executeRaw },
  userId: string,
  workDate: string,
) {
  return db.$executeRaw`INSERT INTO time_entries (user_id, project_id, task_id, work_date, hours, is_billable, updated_at)
    VALUES (${userId}::uuid, ${task.projectId}::uuid, ${task.taskId}::uuid, ${workDate}::date, 1, true, now())`;
}
const dbCodeOf = async (promise: Promise<unknown>) =>
  postgresErrorCode(await promise.catch((e: unknown) => e));

describe('POST /api/locked-periods (locking)', () => {
  it('lets an admin lock a month and records a billing snapshot in the audit trail', async () => {
    await log('dev', MAR, 6);
    await log('dev2', MAR, 2.5);
    await log('dev', FEB, 8);

    const res = await lock('2026-03', 'admin', 'March close');

    expect(res.status).toBe(201);
    expect((res.body as { lockedPeriod: object }).lockedPeriod).toMatchObject({
      period: '2026-03',
      note: 'March close',
      lockedBy: { id: ids.admin },
    });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PERIOD_LOCKED' } });
    expect(audit).toMatchObject({ actorId: ids.admin, entityType: 'locked_period' });
    expect(audit.metadata).toMatchObject({
      period: '2026-03',
      entryCount: 2,
      totalHours: 8.5,
      note: 'March close',
    });
  });

  it.each(['dev', 'ma'] as const)('forbids %s (403) and anonymous users (401)', async (who) => {
    expect((await lock('2026-03', who)).status).toBe(403);
    expect(
      (await request(app).post('/api/locked-periods').send({ period: '2026-03' })).status,
    ).toBe(401);
    expect(await prisma.lockedPeriod.count()).toBe(0);
  });

  it('validates the period and rejects unknown fields', async () => {
    for (const bad of ['2026-13', '2026-3', 'March', '2026-03-01', '']) {
      expect((await as('admin').post('/api/locked-periods', { period: bad })).status).toBe(400);
    }
    expect(
      (await as('admin').post('/api/locked-periods', { period: '2026-03', extra: 1 })).status,
    ).toBe(400);
  });

  it('rejects locking an already locked month (409), with a single audit record', async () => {
    expect((await lock('2026-03')).status).toBe(201);

    const again = await lock('2026-03');

    expect(again.status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: 'PERIOD_LOCKED' } })).toBe(1);
  });

  it('is visible to every signed-in user, newest first', async () => {
    await lock('2026-02');
    await lock('2026-03');

    const res = await as('dev').get('/api/locked-periods');

    expect(
      (res.body as { lockedPeriods: { period: string }[] }).lockedPeriods.map((p) => p.period),
    ).toEqual(['2026-03', '2026-02']);
    expect((await request(app).get('/api/locked-periods')).status).toBe(401);
  });
});

describe('locked periods are immutable through the API (enforced by the service layer)', () => {
  it('rejects create, update and delete in a locked month, and leaves data untouched', async () => {
    const entryId = await log('dev', MAR, 4);
    await lock('2026-03');

    const create = await as('dev').post('/api/time-entries', {
      ...task,
      workDate: MAR,
      hours: 1,
      isBillable: true,
    });
    const update = await as('dev').patch(`/api/time-entries/${entryId}`, { hours: 2 });
    const notesOnly = await as('dev').patch(`/api/time-entries/${entryId}`, { notes: 'sneaky' });
    const del = await as('dev').del(`/api/time-entries/${entryId}`);

    for (const res of [create, update, notesOnly, del]) {
      expect(res.status).toBe(409);
      expect(errorOf(res)).toMatchObject({
        code: 'PERIOD_LOCKED',
        details: { period: '2026-03', enforcedBy: 'service' },
      });
    }
    expect(await hoursOf(entryId)).toBe('4');
    expect(await prisma.timeEntry.count()).toBe(1);
  });

  it('rejects moving an entry into a locked month or out of one', async () => {
    const feb = await log('dev', FEB);
    const mar = await log('dev', MAR);
    await lock('2026-03');

    const into = await as('dev').patch(`/api/time-entries/${feb}`, { workDate: MAR });
    const out = await as('dev').patch(`/api/time-entries/${mar}`, { workDate: FEB });

    expect(into.status).toBe(409);
    expect(out.status).toBe(409);
    const rows = await prisma.timeEntry.findMany({ orderBy: { workDate: 'asc' } });
    expect(rows.map((r) => r.workDate.toISOString().slice(0, 10))).toEqual([FEB, MAR]);
  });

  it('leaves other months editable', async () => {
    const feb = await log('dev', FEB);
    await lock('2026-03');

    expect((await as('dev').patch(`/api/time-entries/${feb}`, { hours: 5 })).status).toBe(200);
    expect(
      (
        await as('dev').post('/api/time-entries', {
          ...task,
          workDate: APR,
          hours: 1,
          isBillable: true,
        })
      ).status,
    ).toBe(201);
    expect((await as('dev').del(`/api/time-entries/${feb}`)).status).toBe(204);
  });

  it('splits a week at the month boundary: Sunday 1 March is locked, Friday 27 February is not', async () => {
    const fri = await log('dev', '2026-02-27');
    const sun = await log('dev', '2026-03-01');
    await lock('2026-03');

    expect((await as('dev').patch(`/api/time-entries/${sun}`, { hours: 1 })).status).toBe(409);
    expect((await as('dev').patch(`/api/time-entries/${fri}`, { hours: 1 })).status).toBe(200);
  });

  it('applies to admins too: nobody is exempt from a lock', async () => {
    await lock('2026-03');

    const res = await as('admin').post('/api/time-entries', {
      ...task,
      workDate: MAR,
      hours: 1,
      isBillable: true,
    });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('PERIOD_LOCKED');
  });

  it("refuses other users' entries before anything else, without leaking lock state", async () => {
    const entryId = await log('dev', MAR, 4);
    await lock('2026-03');
    const path = `/api/time-entries/${entryId}`;

    const colleague = await as('dev2').patch(path, { hours: 1 });
    const otherManager = await as('mb').del(path);
    const manager = await as('ma').patch(path, { hours: 1 });
    const admin = await as('admin').del(path);

    expect(colleague.status).toBe(404);
    expect(otherManager.status).toBe(404);
    expect(manager.status).toBe(403);
    expect(admin.status).toBe(403);
    expect(await hoursOf(entryId)).toBe('4');
  });

  it('refuses to REJECT a week that touches a locked month, but still allows approving it', async () => {
    await log('dev', '2026-03-09');
    const submitted = await as('dev').post('/api/submissions', { weekStart: '2026-03-09' });
    const id = (submitted.body as { submission: { id: string } }).submission.id;
    await lock('2026-03');

    const reject = await as('ma').post(`/api/submissions/${id}/reject`, { comment: 'fix it' });
    expect(reject.status).toBe(409);
    expect(errorOf(reject).code).toBe('PERIOD_LOCKED');
    expect((await prisma.weeklySubmission.findUniqueOrThrow({ where: { id } })).status).toBe(
      'SUBMITTED',
    );
    expect(await prisma.approval.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'SUBMISSION_REJECTED' } })).toBe(0);

    expect((await as('ma').post(`/api/submissions/${id}/approve`)).status).toBe(200);
  });
});

describe('unlocking', () => {
  it('reopens the month, requires a reason, and writes an audit record', async () => {
    const entryId = await log('dev', MAR, 4);
    await lock('2026-03');

    expect((await as('admin').post('/api/locked-periods/2026-03/unlock', {})).status).toBe(400);
    expect(
      (await as('admin').post('/api/locked-periods/2026-03/unlock', { reason: 'x' })).status,
    ).toBe(400);
    expect((await as('dev').patch(`/api/time-entries/${entryId}`, { hours: 1 })).status).toBe(409);

    const res = await unlock('2026-03', 'Finance approved a correction');
    expect(res.status).toBe(204);

    expect((await as('dev').patch(`/api/time-entries/${entryId}`, { hours: 1 })).status).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PERIOD_UNLOCKED' } });
    expect(audit).toMatchObject({ actorId: ids.admin });
    expect(audit.metadata).toMatchObject({
      period: '2026-03',
      reason: 'Finance approved a correction',
    });
  });

  it('is admin only, and only possible for a locked month', async () => {
    await lock('2026-03');

    expect((await unlock('2026-03', 'a reason', 'ma')).status).toBe(403);
    expect((await unlock('2026-03', 'a reason', 'dev')).status).toBe(403);
    expect(
      (await request(app).post('/api/locked-periods/2026-03/unlock').send({ reason: 'abc' }))
        .status,
    ).toBe(401);
    expect(await prisma.lockedPeriod.count()).toBe(1);

    expect((await unlock('2026-04')).status).toBe(404);
  });

  it('allows locking again after an unlock', async () => {
    await lock('2026-03');
    await unlock('2026-03');

    expect((await lock('2026-03')).status).toBe(201);
    expect(await prisma.auditLog.count()).toBe(3);
  });
});

describe('database layer: the trigger blocks writes that bypass the application (SQLSTATE LK001)', () => {
  it('rejects raw INSERT, UPDATE and DELETE on entries in a locked month', async () => {
    const entryId = await log('dev', MAR, 4);
    const feb = await log('dev', FEB, 4);
    await lock('2026-03');

    expect(await dbCodeOf(rawInsert(prisma, ids.dev, MAR))).toBe('LK001');
    expect(
      await dbCodeOf(
        prisma.$executeRaw`UPDATE time_entries SET hours = 9 WHERE id = ${entryId}::uuid`,
      ),
    ).toBe('LK001');
    expect(
      await dbCodeOf(prisma.$executeRaw`DELETE FROM time_entries WHERE id = ${entryId}::uuid`),
    ).toBe('LK001');
    expect(
      await dbCodeOf(prisma.timeEntry.update({ where: { id: entryId }, data: { hours: 9 } })),
    ).toBe('LK001');
    expect(await dbCodeOf(prisma.timeEntry.delete({ where: { id: entryId } }))).toBe('LK001');
    expect(await dbCodeOf(prisma.timeEntry.deleteMany({ where: { workDate: date(MAR) } }))).toBe(
      'LK001',
    );

    expect(await hoursOf(entryId)).toBe('4');
    expect(await prisma.timeEntry.count()).toBe(2);
    expect(feb).toBeTruthy();
  });

  it('rejects moving a row into or out of a locked month with raw SQL', async () => {
    const feb = await log('dev', FEB);
    const mar = await log('dev', MAR);
    await lock('2026-03');

    expect(
      await dbCodeOf(
        prisma.$executeRaw`UPDATE time_entries SET work_date = ${MAR}::date WHERE id = ${feb}::uuid`,
      ),
    ).toBe('LK001');
    expect(
      await dbCodeOf(
        prisma.$executeRaw`UPDATE time_entries SET work_date = ${FEB}::date WHERE id = ${mar}::uuid`,
      ),
    ).toBe('LK001');
  });

  it('still allows raw writes to unlocked months, and to March again once the lock row is gone', async () => {
    const mar = await log('dev', MAR);
    await lock('2026-03');

    await expect(rawInsert(prisma, ids.dev, APR)).resolves.toBe(1);
    await unlock('2026-03');
    await expect(
      prisma.$executeRaw`UPDATE time_entries SET hours = 9 WHERE id = ${mar}::uuid`,
    ).resolves.toBe(1);
  });

  it('reports a database-layer hit through the API as the same 409 when the service check is bypassed', async () => {
    // Same wrapper the services use, applied to a write that skipped the service check.
    const { mapPeriodLockDatabaseError } = await import('../src/services/period-lock.service.js');
    await log('dev', MAR);
    await lock('2026-03');

    const error = mapPeriodLockDatabaseError(
      await rawInsert(prisma, ids.dev, MAR).catch((e: unknown) => e),
    ) as { status: number; code: string; details: unknown };

    expect(error).toMatchObject({
      status: 409,
      code: 'PERIOD_LOCKED',
      details: { period: '2026-03', enforcedBy: 'database' },
    });
  });
});

describe('concurrency: a lock racing an edit never lets a change land after the lock', () => {
  it('lock waits for an in-flight write to commit (trigger takes a shared period lock)', async () => {
    let writerEnd = 0;
    const writer = prisma
      .$transaction(
        async (tx) => {
          await rawInsert(tx, ids.dev, MAR); // raw SQL: only the trigger can protect this write
          await sleep(600); // transaction stays open: the write is not yet committed
        },
        { timeout: 10_000 },
      )
      .then(() => {
        writerEnd = Date.now();
      });
    await sleep(200);

    const lockResponse = await lock('2026-03');
    const lockEnd = Date.now();
    await writer;

    expect(lockResponse.status).toBe(201);
    expect(lockEnd).toBeGreaterThanOrEqual(writerEnd); // the lock had to wait for the writer
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'PERIOD_LOCKED' } });
    expect((audit.metadata as { entryCount: number }).entryCount).toBe(1); // writer's row is in the snapshot
    expect(await dbCodeOf(rawInsert(prisma, ids.dev, MAR))).toBe('LK001');
  });

  it('a write that starts while the lock is being committed waits, then is rejected', async () => {
    const locker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('period_lock:2026-03', 0))`;
        await tx.lockedPeriod.create({
          data: { periodStart: date('2026-03-01'), lockedById: ids.admin },
        });
        await sleep(600); // lock row exists but is NOT committed yet
      },
      { timeout: 10_000 },
    );
    await sleep(200);

    const [, rawResult, apiResult] = await Promise.all([
      locker,
      dbCodeOf(rawInsert(prisma, ids.dev, MAR)), // trigger only
      as('dev').post('/api/time-entries', { ...task, workDate: MAR, hours: 1, isBillable: true }), // service layer
    ]);

    expect(rawResult).toBe('LK001');
    expect(apiResult.status).toBe(409);
    expect(errorOf(apiResult).code).toBe('PERIOD_LOCKED');
    expect(await prisma.timeEntry.count()).toBe(0);
  });

  it('keeps the invariant over many random interleavings (entries committed == entries frozen)', async () => {
    const extra = [
      await createUser(prisma, { email: 'x1@t.dev', managerId: ids.ma }),
      await createUser(prisma, { email: 'x2@t.dev', managerId: ids.ma }),
    ];
    const writers: Who[] = ['dev', 'dev2'];
    const extraCookies = await Promise.all(extra.map((u) => loginToken(app, u.email)));

    for (let round = 1; round <= 8; round++) {
      const month = String(round).padStart(2, '0');
      const period = `2025-${month}`;
      const writes: Promise<request.Response>[] = [];
      for (let day = 1; day <= 4; day++) {
        const body = {
          ...task,
          workDate: `${period}-${String(day).padStart(2, '0')}`,
          hours: 1,
          isBillable: true,
        };
        for (const who of writers) writes.push(as(who).post('/api/time-entries', body));
        for (const c of extraCookies)
          writes.push(request(app).post('/api/time-entries').set('Cookie', c).send(body));
      }

      const [lockResponse, ...results] = await Promise.all([lock(period), ...writes]);

      expect(lockResponse.status).toBe(201);
      for (const r of results) {
        expect([201, 409]).toContain(r.status);
        if (r.status === 409) expect(errorOf(r).code).toBe('PERIOD_LOCKED');
      }
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'PERIOD_LOCKED', metadata: { path: ['period'], equals: period } },
      });
      const frozen = (audit.metadata as { entryCount: number }).entryCount;
      const committed = await prisma.timeEntry.count({
        where: {
          workDate: {
            gte: date(`${period}-01`),
            lt: date(`2025-${String(round + 1).padStart(2, '0')}-01`),
          },
        },
      });
      // Nothing may have been added (or removed) after the lock became visible.
      expect(committed).toBe(frozen);
      expect(results.filter((r) => r.status === 201)).toHaveLength(frozen);
    }
  }, 60_000);

  it('lets exactly one of several concurrent lock requests win', async () => {
    const results = await Promise.all([lock('2026-03'), lock('2026-03'), lock('2026-03')]);

    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await prisma.lockedPeriod.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'PERIOD_LOCKED' } })).toBe(1);
  });
});
