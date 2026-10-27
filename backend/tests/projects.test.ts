import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const cookies: Record<string, string> = {};

interface ProjectBody {
  project: {
    id: string;
    code: string;
    isActive: boolean;
    budgetHours: number;
    tasks?: { id: string; name: string; isActive: boolean }[];
  };
}

beforeAll(async () => {
  await resetDatabase(prisma);
  const manager = await createUser(prisma, { email: 'm@t.dev', role: 'MANAGER' });
  await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
  await createUser(prisma, { email: 'dev@t.dev', managerId: manager.id });
  for (const who of ['m', 'admin', 'dev']) cookies[who] = await loginToken(app, `${who}@t.dev`);
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

describe('reading projects', () => {
  it('rejects anonymous access', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
  });

  it('shows contributors only active projects with active tasks', async () => {
    const live = await createProjectWithTask(prisma, { code: 'LIVE' });
    await prisma.task.create({
      data: { projectId: live.project.id, name: 'Old', isActive: false },
    });
    await createProjectWithTask(prisma, { code: 'OLD' });
    await prisma.project.update({ where: { code: 'OLD' }, data: { isActive: false } });

    const res = await as('dev').get('/api/projects');

    expect(res.status).toBe(200);
    const projects = (res.body as { projects: ProjectBody['project'][] }).projects;
    expect(projects.map((p) => p.code)).toEqual(['LIVE']);
    expect(projects[0]!.tasks!.map((t) => t.name)).toEqual(['Build']);
    expect(projects[0]!.budgetHours).toBeUndefined(); // budgets are admin information
  });

  it('hides archived projects from non-admins (404) and reserves includeArchived for admins', async () => {
    const archived = await prisma.project.findUniqueOrThrow({ where: { code: 'OLD' } });

    expect((await as('dev').get(`/api/projects/${archived.id}`)).status).toBe(404);
    expect((await as('dev').get('/api/projects?includeArchived=true')).status).toBe(403);
    expect((await as('m').get('/api/projects?includeArchived=true')).status).toBe(403);

    const adminList = await as('admin').get('/api/projects?includeArchived=true');
    expect(
      (adminList.body as { projects: { code: string }[] }).projects.map((p) => p.code),
    ).toEqual(['LIVE', 'OLD']);
    expect((await as('admin').get(`/api/projects/${archived.id}`)).status).toBe(200);
  });

  it('rejects a malformed id', async () => {
    expect((await as('dev').get('/api/projects/nope')).status).toBe(400);
  });
});

describe('creating and updating projects (admin only)', () => {
  const valid = {
    code: 'NEW-1',
    name: 'New project',
    budgetHours: 250.5,
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  };

  it('lets an admin create a project', async () => {
    const res = await as('admin').post('/api/projects', valid);

    expect(res.status).toBe(201);
    expect((res.body as ProjectBody).project).toMatchObject({
      code: 'NEW-1',
      budgetHours: 250.5,
      isActive: true,
    });
  });

  it('forbids a contributor from creating, updating or adding tasks', async () => {
    const who = 'dev';
    const target = await prisma.project.findUniqueOrThrow({ where: { code: 'LIVE' } });
    const before = await prisma.project.count();

    expect((await as(who).post('/api/projects', { ...valid, code: 'NOPE' })).status).toBe(403);
    expect((await as(who).patch(`/api/projects/${target.id}`, { name: 'Hacked' })).status).toBe(
      403,
    );
    expect((await as(who).post(`/api/projects/${target.id}/tasks`, { name: 'X' })).status).toBe(
      403,
    );

    expect(await prisma.project.count()).toBe(before);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: target.id } })).name).toBe(
      'Project LIVE',
    );
  });

  it('forbids a manager from creating or updating projects (managers only add tasks)', async () => {
    const target = await prisma.project.findUniqueOrThrow({ where: { code: 'LIVE' } });
    expect((await as('m').post('/api/projects', { ...valid, code: 'NOPE' })).status).toBe(403);
    expect((await as('m').patch(`/api/projects/${target.id}`, { name: 'Hacked' })).status).toBe(
      403,
    );
  });

  it('rejects a duplicate code with 409', async () => {
    const res = await as('admin').post('/api/projects', valid);

    expect(res.status).toBe(409);
    expect(code(res)).toBe('CONFLICT');
  });

  it.each([
    ['negative budget', { ...valid, code: 'V1', budgetHours: -1 }],
    ['bad code characters', { ...valid, code: 'has space' }],
    ['unknown field', { ...valid, code: 'V2', isActive: false }],
    ['invalid date', { ...valid, code: 'V3', startDate: '2026-02-30' }],
  ])('validates input: %s -> 400', async (_label, body) => {
    expect((await as('admin').post('/api/projects', body)).status).toBe(400);
  });

  it('rejects an end date before the start date with 422', async () => {
    const res = await as('admin').post('/api/projects', {
      ...valid,
      code: 'V4',
      startDate: '2026-05-01',
      endDate: '2026-04-01',
    });

    expect(res.status).toBe(422);
  });

  it('updates fields, archives and un-archives', async () => {
    const target = await prisma.project.findUniqueOrThrow({ where: { code: 'NEW-1' } });

    const renamed = await as('admin').patch(`/api/projects/${target.id}`, {
      name: 'Renamed',
      budgetHours: 300,
    });
    expect((renamed.body as ProjectBody).project).toMatchObject({ budgetHours: 300 });

    await as('admin').patch(`/api/projects/${target.id}`, { isActive: false });
    expect((await as('dev').get(`/api/projects/${target.id}`)).status).toBe(404);
    await as('admin').patch(`/api/projects/${target.id}`, { isActive: true });
    expect((await as('dev').get(`/api/projects/${target.id}`)).status).toBe(200);
  });

  it('validates updates: empty body 400, code clash 409, date order 422, unknown id 404', async () => {
    const target = await prisma.project.findUniqueOrThrow({ where: { code: 'NEW-1' } });

    expect((await as('admin').patch(`/api/projects/${target.id}`, {})).status).toBe(400);
    expect((await as('admin').patch(`/api/projects/${target.id}`, { code: 'LIVE' })).status).toBe(
      409,
    );
    expect(
      (await as('admin').patch(`/api/projects/${target.id}`, { endDate: '2025-01-01' })).status,
    ).toBe(422);
    expect(
      (await as('admin').patch('/api/projects/11111111-1111-4111-8111-111111111111', { name: 'x' }))
        .status,
    ).toBe(404);
  });
});

describe('tasks (admin)', () => {
  it('creates, renames and archives a task; names are unique per project', async () => {
    const project = await prisma.project.findUniqueOrThrow({ where: { code: 'LIVE' } });

    const created = await as('admin').post(`/api/projects/${project.id}/tasks`, { name: 'Design' });
    expect(created.status).toBe(201);
    const taskId = (created.body as { task: { id: string } }).task.id;

    expect(
      (await as('admin').post(`/api/projects/${project.id}/tasks`, { name: 'Design' })).status,
    ).toBe(409);

    const renamed = await as('admin').patch(`/api/projects/${project.id}/tasks/${taskId}`, {
      name: 'UX Design',
    });
    expect((renamed.body as { task: { name: string } }).task.name).toBe('UX Design');

    await as('admin').patch(`/api/projects/${project.id}/tasks/${taskId}`, { isActive: false });
    const visible = await as('dev').get(`/api/projects/${project.id}`);
    expect((visible.body as ProjectBody).project.tasks!.map((t) => t.name)).toEqual(['Build']);
  });

  it('does not let a task be addressed through the wrong project', async () => {
    const live = await prisma.project.findUniqueOrThrow({ where: { code: 'LIVE' } });
    const other = await prisma.project.findUniqueOrThrow({ where: { code: 'NEW-1' } });
    const task = await prisma.task.findFirstOrThrow({
      where: { projectId: live.id, name: 'Build' },
    });

    const res = await as('admin').patch(`/api/projects/${other.id}/tasks/${task.id}`, {
      name: 'Moved',
    });

    expect(res.status).toBe(404);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).name).toBe('Build');
  });
});
