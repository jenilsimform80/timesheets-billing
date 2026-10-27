import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createTestPrisma,
  createUser,
  loginToken,
  resetDatabase,
  type ApiErrorBody,
} from './helpers.js';

const prisma = createTestPrisma();
const app = buildTestApp(prisma);
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const WEEK = '2026-03-02';

interface TaskBody {
  id: string;
  name: string;
  canLog: boolean;
  canManage: boolean;
  assigneeIds?: string[];
}

beforeAll(async () => {
  await resetDatabase(prisma);
  // admin; boss (top manager) <- mgr (manager) <- dev1, dev2; mgr2 with its own report dev3.
  const boss = await createUser(prisma, { email: 'boss@t.dev', role: 'MANAGER' });
  const mgr = await createUser(prisma, { email: 'mgr@t.dev', role: 'MANAGER', managerId: boss.id });
  const mgr2 = await createUser(prisma, { email: 'mgr2@t.dev', role: 'MANAGER' });
  const dev1 = await createUser(prisma, { email: 'dev1@t.dev', managerId: mgr.id });
  const dev2 = await createUser(prisma, { email: 'dev2@t.dev', managerId: mgr.id });
  const dev3 = await createUser(prisma, { email: 'dev3@t.dev', managerId: mgr2.id });
  const admin = await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
  Object.assign(ids, { boss, mgr, mgr2, dev1, dev2, dev3, admin });
  for (const k of Object.keys(ids)) ids[k] = (ids[k] as unknown as { id: string }).id;
  for (const who of ['boss', 'mgr', 'mgr2', 'dev1', 'dev2', 'dev3', 'admin']) {
    cookies[who] = await loginToken(app, `${who}@t.dev`);
  }
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
});
const code = (res: request.Response) => (res.body as ApiErrorBody).error.code;

async function adminProject(body: object) {
  const res = await as('admin').post('/api/projects', {
    code: 'P',
    name: 'P',
    budgetHours: 100,
    ...body,
  });
  expect(res.status).toBe(201);
  const project = (res.body as { project: { id: string } }).project;
  const task = await as('admin').post(`/api/projects/${project.id}/tasks`, { name: 'Build' });
  expect(task.status).toBe(201);
  return { projectId: project.id, taskId: (task.body as { task: { id: string } }).task.id };
}

const logTime = (who: string, projectId: string, taskId: string, workDate = WEEK) =>
  as(who).post('/api/time-entries', { projectId, taskId, workDate, hours: 2, isBillable: true });

describe('restricted projects', () => {
  it('are hidden from non-members, visible to members and admins, and cannot be logged against', async () => {
    const { projectId, taskId } = await adminProject({
      code: 'SECRET',
      isRestricted: true,
      memberIds: [ids['dev1']!, ids['mgr']!],
    });

    // Non-member: absent from the list, 404 by id (indistinguishable from a missing project).
    const list = await as('dev2').get('/api/projects');
    expect((list.body as { projects: { code: string }[] }).projects.map((p) => p.code)).toEqual([]);
    expect((await as('dev2').get(`/api/projects/${projectId}`)).status).toBe(404);
    const blocked = await logTime('dev2', projectId, taskId);
    expect(blocked.status).toBe(404);
    expect(await prisma.timeEntry.count({ where: { projectId } })).toBe(0);

    // Members and the admin see it; the member list is admin-only information.
    expect((await as('dev1').get(`/api/projects/${projectId}`)).status).toBe(200);
    expect((await as('mgr').get(`/api/projects/${projectId}`)).status).toBe(200);
    const adminView = await as('admin').get(`/api/projects/${projectId}`);
    expect(
      (adminView.body as { project: { memberIds: string[] } }).project.memberIds.sort(),
    ).toEqual([ids['dev1']!, ids['mgr']!].sort());
    const memberView = await as('dev1').get(`/api/projects/${projectId}`);
    expect((memberView.body as { project: object }).project).not.toHaveProperty('memberIds');
    expect((await logTime('dev1', projectId, taskId)).status).toBe(201);
  });

  it('replaces the member list on update and takes effect immediately', async () => {
    const { projectId } = await adminProject({
      code: 'SWAP',
      isRestricted: true,
      memberIds: [ids['dev1']!],
    });
    expect((await as('dev3').get(`/api/projects/${projectId}`)).status).toBe(404);
    const res = await as('admin').patch(`/api/projects/${projectId}`, {
      memberIds: [ids['dev3']!],
    });
    expect(res.status).toBe(200);
    expect((await as('dev3').get(`/api/projects/${projectId}`)).status).toBe(200);
    expect((await as('dev1').get(`/api/projects/${projectId}`)).status).toBe(404);

    // Opening the project to everyone again.
    await as('admin').patch(`/api/projects/${projectId}`, { isRestricted: false, memberIds: [] });
    expect((await as('dev1').get(`/api/projects/${projectId}`)).status).toBe(200);
  });

  it('rejects members on an open project, admin or unknown members, and non-admin callers', async () => {
    const base = { code: 'BAD', name: 'Bad', budgetHours: 1 };
    const open = await as('admin').post('/api/projects', { ...base, memberIds: [ids['dev1']!] });
    expect(open.status).toBe(422);
    const admins = await as('admin').post('/api/projects', {
      ...base,
      isRestricted: true,
      memberIds: [ids['admin']!],
    });
    expect(admins.status).toBe(422);
    const unknown = await as('admin').post('/api/projects', {
      ...base,
      isRestricted: true,
      memberIds: ['00000000-0000-4000-8000-000000000000'],
    });
    expect(unknown.status).toBe(422);
    expect(await prisma.project.count({ where: { code: 'BAD' } })).toBe(0);

    const target = await adminProject({ code: 'NOEDIT' });
    for (const who of ['mgr', 'dev1']) {
      const res = await as(who).patch(`/api/projects/${target.projectId}`, {
        isRestricted: true,
        memberIds: [ids[who]!],
      });
      expect(res.status).toBe(403);
    }
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: target.projectId } })).isRestricted,
    ).toBe(false);
  });

  it('keeps existing entries readable after a member is removed, but blocks new ones', async () => {
    const { projectId, taskId } = await adminProject({
      code: 'REMOVED',
      isRestricted: true,
      memberIds: [ids['dev3']!],
    });
    expect((await logTime('dev3', projectId, taskId)).status).toBe(201);
    await as('admin').patch(`/api/projects/${projectId}`, { memberIds: [ids['dev1']!] });
    expect((await logTime('dev3', projectId, taskId, '2026-03-03')).status).toBe(404);
    expect(await prisma.timeEntry.count({ where: { projectId, userId: ids['dev3']! } })).toBe(1);
  });
});

describe('tasks created by managers and assigned to contributors', () => {
  it('lets a manager create a task assigned to a direct report; only the assignee can log to it', async () => {
    const { projectId } = await adminProject({ code: 'TASKS' });
    const res = await as('mgr').post(`/api/projects/${projectId}/tasks`, {
      name: 'Fix login',
      assigneeIds: [ids['dev1']!],
    });
    expect(res.status).toBe(201);
    const task = (res.body as { task: TaskBody }).task;
    expect(task).toMatchObject({ canManage: true, canLog: false, assigneeIds: [ids['dev1']] });

    expect((await logTime('dev1', projectId, task.id)).status).toBe(201);
    const other = await logTime('dev2', projectId, task.id);
    expect(other.status).toBe(422);
    expect(code(other)).toBe('BUSINESS_RULE_VIOLATION');

    // Contributors see whether they may log, never who else is assigned.
    const seen = await as('dev2').get(`/api/projects/${projectId}`);
    const dev2Task = (seen.body as { project: { tasks: TaskBody[] } }).project.tasks.find(
      (t) => t.id === task.id,
    )!;
    expect(dev2Task).toMatchObject({ canLog: false, canManage: false });
    expect(dev2Task).not.toHaveProperty('assigneeIds');
    const mine = await as('dev1').get(`/api/projects/${projectId}`);
    expect(
      (mine.body as { project: { tasks: TaskBody[] } }).project.tasks.find((t) => t.id === task.id),
    ).toMatchObject({ canLog: true });
  });

  it('keeps unassigned tasks open to everyone and can be re-opened by clearing assignees', async () => {
    const { projectId, taskId } = await adminProject({ code: 'OPEN' });
    expect((await logTime('dev2', projectId, taskId)).status).toBe(201);
    const created = await as('mgr').post(`/api/projects/${projectId}/tasks`, {
      name: 'Narrow',
      assigneeIds: [ids['dev1']!],
    });
    const id = (created.body as { task: TaskBody }).task.id;
    expect((await logTime('dev2', projectId, id, '2026-03-03')).status).toBe(422);
    const reopened = await as('mgr').patch(`/api/projects/${projectId}/tasks/${id}`, {
      assigneeIds: [],
    });
    expect(reopened.status).toBe(200);
    expect((await logTime('dev2', projectId, id, '2026-03-03')).status).toBe(201);
  });

  it('refuses assigning people who are not the manager or their active direct reports', async () => {
    const { projectId } = await adminProject({ code: 'SCOPE' });
    for (const bad of [ids['dev3']!, ids['boss']!, ids['admin']!]) {
      const res = await as('mgr').post(`/api/projects/${projectId}/tasks`, {
        name: `T-${bad.slice(0, 4)}`,
        assigneeIds: [bad],
      });
      expect(res.status).toBe(422);
    }
    await prisma.user.update({ where: { id: ids['dev2']! }, data: { isActive: false } });
    const inactive = await as('mgr').post(`/api/projects/${projectId}/tasks`, {
      name: 'Inactive',
      assigneeIds: [ids['dev2']!],
    });
    await prisma.user.update({ where: { id: ids['dev2']! }, data: { isActive: true } });
    expect(inactive.status).toBe(422);
    // The manager may assign themself.
    const self = await as('mgr').post(`/api/projects/${projectId}/tasks`, {
      name: 'Mine',
      assigneeIds: [ids['mgr']!],
    });
    expect(self.status).toBe(201);
    expect(await prisma.task.count({ where: { projectId, name: 'Inactive' } })).toBe(0);
  });

  it('only lets a manager change tasks they created; contributors cannot create tasks', async () => {
    const { projectId, taskId } = await adminProject({ code: 'OWN' });
    expect(
      (await as('mgr').patch(`/api/projects/${projectId}/tasks/${taskId}`, { name: 'X' })).status,
    ).toBe(403);
    const created = await as('mgr').post(`/api/projects/${projectId}/tasks`, { name: 'Mgr task' });
    const id = (created.body as { task: TaskBody }).task.id;
    expect(
      (await as('mgr2').patch(`/api/projects/${projectId}/tasks/${id}`, { name: 'Steal' })).status,
    ).toBe(403);
    expect(
      (await as('mgr').patch(`/api/projects/${projectId}/tasks/${id}`, { name: 'Renamed' })).status,
    ).toBe(200);
    expect(
      (await as('admin').patch(`/api/projects/${projectId}/tasks/${id}`, { name: 'Admin' })).status,
    ).toBe(200);
    expect(
      (await as('dev1').post(`/api/projects/${projectId}/tasks`, { name: 'Nope' })).status,
    ).toBe(403);
  });

  it('treats a restricted project the manager cannot see as missing, and requires assignees to be members', async () => {
    const { projectId } = await adminProject({
      code: 'HIDDEN',
      isRestricted: true,
      memberIds: [ids['mgr']!, ids['dev1']!],
    });
    expect((await as('mgr2').post(`/api/projects/${projectId}/tasks`, { name: 'X' })).status).toBe(
      404,
    );
    const nonMember = await as('mgr').post(`/api/projects/${projectId}/tasks`, {
      name: 'ForDev2',
      assigneeIds: [ids['dev2']!],
    });
    expect(nonMember.status).toBe(422);
    const member = await as('mgr').post(`/api/projects/${projectId}/tasks`, {
      name: 'ForDev1',
      assigneeIds: [ids['dev1']!],
    });
    expect(member.status).toBe(201);
  });
});

describe('a manager who reports to another manager', () => {
  it('submits their own week and the upper manager (only) can approve it', async () => {
    const { projectId, taskId } = await adminProject({ code: 'HIER' });
    expect((await logTime('mgr', projectId, taskId)).status).toBe(201);
    const submitted = await as('mgr').post('/api/submissions', { weekStart: WEEK });
    expect(submitted.status).toBe(201);
    const id = (submitted.body as { submission: { id: string } }).submission.id;

    expect((await as('mgr2').post(`/api/submissions/${id}/approve`, {})).status).toBe(404);
    expect((await as('admin').post(`/api/submissions/${id}/approve`, {})).status).toBe(404); // has a manager
    expect((await as('mgr').post(`/api/submissions/${id}/approve`, {})).status).toBe(404);
    expect((await as('boss').post(`/api/submissions/${id}/approve`, {})).status).toBe(200);
  });

  it('lets the top manager (nobody above them) submit; an admin decides it, not they themself', async () => {
    const { projectId, taskId } = await adminProject({ code: 'TOP' });
    expect((await logTime('boss', projectId, taskId)).status).toBe(201);
    const res = await as('boss').post('/api/submissions', { weekStart: WEEK });
    expect(res.status).toBe(201);
    const id = (res.body as { submission: { id: string } }).submission.id;

    expect((await as('boss').post(`/api/submissions/${id}/approve`, {})).status).toBe(404);
    expect((await as('mgr').post(`/api/submissions/${id}/approve`, {})).status).toBe(404);
    expect((await as('admin').post(`/api/submissions/${id}/approve`, {})).status).toBe(200);
  });
});
