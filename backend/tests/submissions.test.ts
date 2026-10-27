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

const prisma = createTestPrisma();
const app = buildTestApp(prisma);

const WEEK1 = '2026-03-02'; // Monday
const WEEK2 = '2026-03-09'; // Monday

let cookies: Record<string, string>;
let ids: Record<'ma' | 'mb' | 'dev' | 'dev2' | 'devb' | 'admin', string>;
let task: { projectId: string; taskId: string };

interface SubmissionBody {
  submission: {
    id: string;
    userId: string;
    weekStart: string;
    status: string;
    approvals?: { decision: string; comment: string | null; managerId: string }[];
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
  const ma = await createUser(prisma, { email: 'ma@t.dev', role: 'MANAGER' });
  const mb = await createUser(prisma, { email: 'mb@t.dev', role: 'MANAGER' });
  const dev = await createUser(prisma, { email: 'dev@t.dev', managerId: ma.id });
  const dev2 = await createUser(prisma, { email: 'dev2@t.dev', managerId: ma.id });
  const devb = await createUser(prisma, { email: 'devb@t.dev', managerId: mb.id });
  const admin = await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
  await createUser(prisma, { email: 'orphan@t.dev' }); // no manager
  const { project, task: t } = await createProjectWithTask(prisma, { code: 'P1' });
  task = { projectId: project.id, taskId: t.id };
  cookies = {};
  for (const who of ['ma', 'mb', 'dev', 'dev2', 'devb', 'admin', 'orphan']) {
    cookies[who] = await loginToken(app, `${who}@t.dev`);
  }
  ids = { ma: ma.id, mb: mb.id, dev: dev.id, dev2: dev2.id, devb: devb.id, admin: admin.id };
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const as = (who: string) => ({
  get: (path: string) => request(app).get(path).set('Cookie', cookies[who]!),
  post: (path: string, body?: object) =>
    request(app).post(path).set('Cookie', cookies[who]!).send(body),
  patch: (path: string, body?: object) =>
    request(app).patch(path).set('Cookie', cookies[who]!).send(body),
  del: (path: string) => request(app).delete(path).set('Cookie', cookies[who]!),
});
const errorOf = (res: request.Response) => (res.body as ApiErrorBody).error;

async function logEntry(who: string, workDate: string, hours = 8) {
  const res = await as(who).post('/api/time-entries', {
    ...task,
    workDate,
    hours,
    isBillable: true,
  });
  expect(res.status).toBe(201);
  return (res.body as { entry: { id: string } }).entry.id;
}

async function submit(who: string, weekStart = WEEK1) {
  return as(who).post('/api/submissions', { weekStart });
}

async function submitted(who = 'dev', weekStart = WEEK1) {
  await logEntry(who, weekStart);
  const res = await submit(who, weekStart);
  expect(res.status).toBe(201);
  return (res.body as SubmissionBody).submission.id;
}

const statusInDb = async (id: string) =>
  (await prisma.weeklySubmission.findUniqueOrThrow({ where: { id } })).status;

describe('POST /api/submissions', () => {
  it('submits a week with entries', async () => {
    await logEntry('dev', WEEK1);

    const res = await submit('dev');

    expect(res.status).toBe(201);
    expect((res.body as SubmissionBody).submission).toMatchObject({
      userId: ids.dev,
      weekStart: WEEK1,
      status: 'SUBMITTED',
    });
    const week = await as('dev').get(`/api/timesheets/${WEEK1}`);
    expect((week.body as { status: string }).status).toBe('SUBMITTED');
  });

  it('requires authentication and a Monday weekStart, and rejects unknown fields', async () => {
    expect((await request(app).post('/api/submissions').send({ weekStart: WEEK1 })).status).toBe(
      401,
    );
    expect((await as('dev').post('/api/submissions', { weekStart: '2026-03-03' })).status).toBe(
      400,
    );
    expect(
      (await as('dev').post('/api/submissions', { weekStart: WEEK1, userId: ids.dev2 })).status,
    ).toBe(400);
  });

  it('refuses an empty week (422)', async () => {
    const res = await submit('dev');

    expect(res.status).toBe(422);
    expect(await prisma.weeklySubmission.count()).toBe(0);
  });

  it('lets a user with no manager submit: an admin will decide it', async () => {
    await logEntry('orphan', WEEK1);

    expect((await submit('orphan')).status).toBe(201);
  });

  it('refuses (422) when there is no manager and no other active admin to decide', async () => {
    await prisma.user.update({ where: { id: ids.admin }, data: { isActive: false } });
    await logEntry('orphan', WEEK1);

    const res = await submit('orphan');

    expect(res.status).toBe(422);
    expect(await prisma.weeklySubmission.count()).toBe(0);
  });

  it('refuses (422) when the only admin would have to approve their own week', async () => {
    await logEntry('admin', WEEK1);

    expect((await submit('admin')).status).toBe(422);
  });

  it('lets an admin with no manager submit when another active admin exists', async () => {
    await createUser(prisma, { email: 'admin2@t.dev', role: 'ADMIN' });
    await logEntry('admin', WEEK1);

    expect((await submit('admin')).status).toBe(201);
  });

  it('falls back to the admins when the assigned manager is deactivated', async () => {
    await prisma.user.update({ where: { id: ids.ma }, data: { isActive: false } });
    await logEntry('dev', WEEK1);

    expect((await submit('dev')).status).toBe(201);
  });

  it('only ever submits the caller’s own week (no way to submit for someone else)', async () => {
    await logEntry('dev2', WEEK1);

    expect((await submit('dev')).status).toBe(422); // dev has no entries; dev2's are irrelevant
    expect(await prisma.weeklySubmission.count()).toBe(0);
  });

  it('refuses to submit the same week twice (409)', async () => {
    await submitted();

    const again = await submit('dev');

    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('INVALID_STATE');
  });
});

describe('editing after submission', () => {
  it('freezes the week for create, update and delete, but not other weeks', async () => {
    const entryId = await logEntry('dev', WEEK1);
    await logEntry('dev', WEEK1, 2);
    const other = await logEntry('dev', WEEK2);
    expect((await submit('dev')).status).toBe(201);

    const create = await as('dev').post('/api/time-entries', {
      ...task,
      workDate: WEEK1,
      hours: 1,
      isBillable: true,
    });
    const update = await as('dev').patch(`/api/time-entries/${entryId}`, { hours: 1 });
    const del = await as('dev').del(`/api/time-entries/${entryId}`);

    for (const res of [create, update, del]) {
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe('WEEK_NOT_EDITABLE');
    }
    expect(
      (await prisma.timeEntry.findUniqueOrThrow({ where: { id: entryId } })).hours.toString(),
    ).toBe('8');
    expect(await prisma.timeEntry.count()).toBe(3);
    expect((await as('dev').patch(`/api/time-entries/${other}`, { hours: 3 })).status).toBe(200);
  });

  it('blocks moving an entry out of, or into, a submitted week', async () => {
    const inWeek1 = await logEntry('dev', WEEK1);
    const inWeek2 = await logEntry('dev', WEEK2);
    await submit('dev', WEEK1);

    const out = await as('dev').patch(`/api/time-entries/${inWeek1}`, { workDate: WEEK2 });
    const into = await as('dev').patch(`/api/time-entries/${inWeek2}`, { workDate: WEEK1 });

    expect(out.status).toBe(409);
    expect(into.status).toBe(409);
  });

  it('keeps the week frozen after approval', async () => {
    const id = await submitted();
    await as('ma').post(`/api/submissions/${id}/approve`);

    const res = await as('dev').post('/api/time-entries', {
      ...task,
      workDate: WEEK1,
      hours: 1,
      isBillable: true,
    });

    expect(res.status).toBe(409);
  });

  it('does not let a submit race an edit into an inconsistent state', async () => {
    for (let round = 0; round < 6; round++) {
      await resetRows();
      await logEntry('dev', WEEK1, 4);

      const [created, sub] = await Promise.all([
        as('dev').post('/api/time-entries', {
          ...task,
          workDate: WEEK1,
          hours: 2,
          isBillable: true,
        }),
        submit('dev'),
      ]);

      expect(sub.status).toBe(201);
      const count = await prisma.timeEntry.count();
      // Either the entry committed before the submit, or it was refused: never "created but ignored".
      if (created.status === 201) expect(count).toBe(2);
      else {
        expect(created.status).toBe(409);
        expect(count).toBe(1);
      }
    }
  });
});

async function resetRows() {
  await prisma.approval.deleteMany();
  await prisma.weeklySubmission.deleteMany();
  await prisma.timeEntry.deleteMany();
}

describe('approve and reject by the direct manager', () => {
  it('approves, records the decision and exposes the history', async () => {
    const id = await submitted();

    const res = await as('ma').post(`/api/submissions/${id}/approve`, { comment: 'Looks good' });

    expect(res.status).toBe(200);
    const submission = (res.body as SubmissionBody).submission;
    expect(submission.status).toBe('APPROVED');
    expect(submission.approvals).toMatchObject([
      { decision: 'APPROVED', comment: 'Looks good', managerId: ids.ma },
    ]);
    expect(await prisma.approval.count()).toBe(1);
  });

  it('approves with no body at all', async () => {
    const id = await submitted();

    expect((await as('ma').post(`/api/submissions/${id}/approve`)).status).toBe(200);
  });

  it('requires a reason to reject (400) and then rejects', async () => {
    const id = await submitted();

    expect((await as('ma').post(`/api/submissions/${id}/reject`, {})).status).toBe(400);
    expect((await as('ma').post(`/api/submissions/${id}/reject`, { comment: '   ' })).status).toBe(
      400,
    );
    expect(await statusInDb(id)).toBe('SUBMITTED');

    const res = await as('ma').post(`/api/submissions/${id}/reject`, { comment: 'Missing Friday' });
    expect(res.status).toBe(200);
    expect((res.body as SubmissionBody).submission.status).toBe('REJECTED');
  });

  it('lets the contributor fix a rejected week and resubmit; history keeps both decisions', async () => {
    const id = await submitted();
    await as('ma').post(`/api/submissions/${id}/reject`, { comment: 'Add Friday' });

    expect((await logEntry('dev', '2026-03-06', 4)).length).toBeGreaterThan(0); // editable again
    const resubmit = await submit('dev');
    expect(resubmit.status).toBe(201);
    expect((resubmit.body as SubmissionBody).submission.id).toBe(id); // same row, status back to SUBMITTED

    const approved = await as('ma').post(`/api/submissions/${id}/approve`);
    const approvals = (approved.body as SubmissionBody).submission.approvals!;
    expect(approvals.map((a) => a.decision)).toEqual(['REJECTED', 'APPROVED']);
    expect(await prisma.weeklySubmission.count()).toBe(1);
  });

  it('cannot decide twice (409) and the first decision stands', async () => {
    const id = await submitted();
    await as('ma').post(`/api/submissions/${id}/approve`);

    const again = await as('ma').post(`/api/submissions/${id}/reject`, {
      comment: 'changed my mind',
    });

    expect(again.status).toBe(409);
    expect(await statusInDb(id)).toBe('APPROVED');
    expect(await prisma.approval.count()).toBe(1);
  });

  it('lets exactly one of two concurrent decisions win', async () => {
    const id = await submitted();

    const results = await Promise.all([
      as('ma').post(`/api/submissions/${id}/approve`),
      as('ma').post(`/api/submissions/${id}/reject`, { comment: 'no' }),
      as('ma').post(`/api/submissions/${id}/approve`),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await prisma.approval.count()).toBe(1);
  });
});

describe('authorization on approve/reject (HTTP level)', () => {
  it('refuses a manager outside the reporting line with 404 and changes nothing', async () => {
    const id = await submitted();

    const approve = await as('mb').post(`/api/submissions/${id}/approve`);
    const reject = await as('mb').post(`/api/submissions/${id}/reject`, { comment: 'nope' });

    expect(approve.status).toBe(404);
    expect(reject.status).toBe(404);
    expect(await statusInDb(id)).toBe('SUBMITTED');
    expect(await prisma.approval.count()).toBe(0);
  });

  it.each([
    ['the owner', 'dev'],
    ['a colleague contributor', 'dev2'],
  ])('refuses %s with 403', async (_label, who) => {
    const id = await submitted();

    const approve = await as(who).post(`/api/submissions/${id}/approve`);
    const reject = await as(who).post(`/api/submissions/${id}/reject`, { comment: 'x' });

    expect(approve.status).toBe(403);
    expect(reject.status).toBe(403);
    expect(await statusInDb(id)).toBe('SUBMITTED');
  });

  it('refuses anonymous callers (401)', async () => {
    const id = await submitted();

    expect((await request(app).post(`/api/submissions/${id}/approve`)).status).toBe(401);
    expect(await statusInDb(id)).toBe('SUBMITTED');
  });

  it('answers a missing id exactly like an out-of-scope id (no probing)', async () => {
    const id = await submitted();

    const foreign = await as('mb').post(`/api/submissions/${id}/approve`);
    const missing = await as('mb').post(
      '/api/submissions/11111111-1111-4111-8111-111111111111/approve',
    );

    expect(missing.status).toBe(foreign.status);
    expect(errorOf(missing)).toEqual(errorOf(foreign));
  });

  it('refuses a manager approving their own submission', async () => {
    // ma has no manager, so give them one to be able to submit, then try to self-approve.
    await prisma.user.update({ where: { id: ids.ma }, data: { managerId: ids.mb } });
    await logEntry('ma', WEEK1);
    const created = await submit('ma');
    const id = (created.body as SubmissionBody).submission.id;

    expect((await as('ma').post(`/api/submissions/${id}/approve`)).status).toBe(404);
    expect(await statusInDb(id)).toBe('SUBMITTED');
  });

  it('follows reassignment: after a report moves to another manager the old manager is refused', async () => {
    const id = await submitted();
    await prisma.user.update({ where: { id: ids.dev }, data: { managerId: ids.mb } });

    expect((await as('ma').post(`/api/submissions/${id}/approve`)).status).toBe(404);
    expect((await as('mb').post(`/api/submissions/${id}/approve`)).status).toBe(200);
  });
});

describe('viewing submissions', () => {
  it('shows each role only its own scope', async () => {
    const mine = await submitted('dev');
    await submitted('dev2');
    await submitted('devb');

    const list = async (who: string, q = '') => {
      const res = await as(who).get(`/api/submissions${q}`);
      expect(res.status).toBe(200);
      return (res.body as { submissions: { userId: string }[] }).submissions
        .map((s) => s.userId)
        .sort();
    };

    expect(await list('dev')).toEqual([ids.dev]);
    expect(await list('ma')).toEqual([ids.dev, ids.dev2].sort());
    expect(await list('mb')).toEqual([ids.devb]);
    expect(await list('admin')).toHaveLength(3);
    expect(await list('ma', '?status=APPROVED')).toEqual([]);
    expect(mine).toBeTruthy();
  });

  it('gives managers an approval queue of reports only (never their own)', async () => {
    await prisma.user.update({ where: { id: ids.ma }, data: { managerId: ids.mb } });
    await submitted('dev');
    await logEntry('ma', WEEK1);
    await submit('ma'); // the manager's own submission

    const queue = await as('ma').get('/api/submissions?forApproval=true&status=SUBMITTED');

    const users = (queue.body as { submissions: { userId: string }[] }).submissions.map(
      (s) => s.userId,
    );
    expect(users).toEqual([ids.dev]);
    expect((await as('dev').get('/api/submissions?forApproval=true')).status).toBe(403);
    expect((await as('orphan').get('/api/submissions?forApproval=true')).status).toBe(403);
  });

  it('GET /:id is visible to the owner, their manager and admin, 404 to everyone else', async () => {
    const id = await submitted('dev');
    const path = `/api/submissions/${id}`;

    for (const who of ['dev', 'ma', 'admin']) expect((await as(who).get(path)).status).toBe(200);
    for (const who of ['mb', 'dev2', 'devb']) expect((await as(who).get(path)).status).toBe(404);
    expect((await request(app).get(path)).status).toBe(401);
  });
});

describe('admin fallback when the owner has no usable manager', () => {
  it('lets an admin approve a manager-less user’s week and records them as the decider', async () => {
    const id = await submitted('orphan');

    const res = await as('admin').post(`/api/submissions/${id}/approve`, { comment: 'ok' });

    expect(res.status).toBe(200);
    const submission = (res.body as SubmissionBody).submission;
    expect(submission.status).toBe('APPROVED');
    expect(submission.approvals).toMatchObject([{ decision: 'APPROVED', managerId: ids.admin }]);
  });

  it('lets an admin reject with a reason', async () => {
    const id = await submitted('orphan');

    expect((await as('admin').post(`/api/submissions/${id}/reject`, {})).status).toBe(400);
    expect(
      (await as('admin').post(`/api/submissions/${id}/reject`, { comment: 'fix it' })).status,
    ).toBe(200);
    expect(await statusInDb(id)).toBe('REJECTED');
  });

  it('refuses an admin for a user who HAS an active manager (404, nothing changes)', async () => {
    const id = await submitted('dev');

    expect((await as('admin').post(`/api/submissions/${id}/approve`)).status).toBe(404);
    expect(await statusInDb(id)).toBe('SUBMITTED');
  });

  it('lets an admin decide once the manager has been deactivated', async () => {
    const id = await submitted('dev');
    await prisma.user.update({ where: { id: ids.ma }, data: { isActive: false } });

    expect((await as('admin').post(`/api/submissions/${id}/approve`)).status).toBe(200);
  });

  it('never lets an admin decide their own week', async () => {
    await createUser(prisma, { email: 'admin2@t.dev', role: 'ADMIN' });
    await logEntry('admin', WEEK1);
    const created = await submit('admin');
    const id = (created.body as SubmissionBody).submission.id;

    expect((await as('admin').post(`/api/submissions/${id}/approve`)).status).toBe(404);
    expect(await statusInDb(id)).toBe('SUBMITTED');
  });

  it('shows admins a queue of only the manager-less submissions', async () => {
    await submitted('dev'); // has a manager: not the admin's to decide
    const orphan = await submitted('orphan');

    const queue = await as('admin').get('/api/submissions?forApproval=true');

    expect(queue.status).toBe(200);
    const list = (queue.body as { submissions: { id: string }[] }).submissions;
    expect(list.map((x) => x.id)).toEqual([orphan]);
  });
});
