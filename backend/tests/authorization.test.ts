import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createTestPrisma,
  createUser,
  resetDatabase,
  TEST_PASSWORD,
  type ApiErrorBody,
  accessCookie,
} from './helpers.js';

const prisma = createTestPrisma();
const app = buildTestApp(prisma);

type Ids = Record<'admin' | 'managerA' | 'managerB' | 'devA1' | 'devA2' | 'devB1', string>;
let ids: Ids;
const cookies: Record<string, string> = {};

async function loginToken(email: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password: TEST_PASSWORD });
  return accessCookie(res);
}

beforeAll(async () => {
  await resetDatabase(prisma);
  const admin = await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
  const managerA = await createUser(prisma, { email: 'ma@t.dev', role: 'MANAGER' });
  const managerB = await createUser(prisma, { email: 'mb@t.dev', role: 'MANAGER' });
  const devA1 = await createUser(prisma, { email: 'a1@t.dev', managerId: managerA.id });
  const devA2 = await createUser(prisma, { email: 'a2@t.dev', managerId: managerA.id });
  const devB1 = await createUser(prisma, { email: 'b1@t.dev', managerId: managerB.id });
  ids = {
    admin: admin.id,
    managerA: managerA.id,
    managerB: managerB.id,
    devA1: devA1.id,
    devA2: devA2.id,
    devB1: devB1.id,
  };
  for (const email of ['admin', 'ma', 'mb', 'a1', 'a2', 'b1']) {
    cookies[email] = await loginToken(`${email}@t.dev`);
  }
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const get = (path: string, who?: string) => {
  const req = request(app).get(path);
  return who ? req.set('Cookie', cookies[who]!) : req;
};
const emailsOf = (res: request.Response) =>
  (res.body as { users: { email: string }[] }).users.map((u) => u.email).sort();

describe('authentication is required', () => {
  it.each([
    '/api/users',
    '/api/users/direct-reports',
    `/api/users/${'0'.repeat(8)}-0000-4000-8000-000000000000`,
  ])('rejects anonymous GET %s with 401', async (path) => {
    const res = await get(path);

    expect(res.status).toBe(401);
    expect((res.body as ApiErrorBody).error.code).toBe('UNAUTHENTICATED');
  });
});

describe('contributor scope (ownership)', () => {
  it('lists and reads only themself', async () => {
    expect(emailsOf(await get('/api/users', 'a1'))).toEqual(['a1@t.dev']);
    expect((await get(`/api/users/${ids.devA1}`, 'a1')).status).toBe(200);
  });

  it("cannot read a colleague's, their manager's or anyone else's record", async () => {
    for (const other of [ids.devA2, ids.managerA, ids.devB1, ids.admin]) {
      const res = await get(`/api/users/${other}`, 'a1');

      expect(res.status).toBe(404);
    }
  });

  it('cannot use manager-only routes', async () => {
    const res = await get('/api/users/direct-reports', 'a1');

    expect(res.status).toBe(403);
    expect((res.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
  });
});

describe('manager scope (direct reports only)', () => {
  it('lists themself plus direct reports', async () => {
    expect(emailsOf(await get('/api/users', 'ma'))).toEqual(['a1@t.dev', 'a2@t.dev', 'ma@t.dev']);
    expect(emailsOf(await get('/api/users/direct-reports', 'ma'))).toEqual([
      'a1@t.dev',
      'a2@t.dev',
    ]);
    expect(emailsOf(await get('/api/users/direct-reports', 'mb'))).toEqual(['b1@t.dev']);
  });

  it('can read a direct report but not another manager’s report or another manager', async () => {
    expect((await get(`/api/users/${ids.devA1}`, 'ma')).status).toBe(200);
    expect((await get(`/api/users/${ids.devB1}`, 'ma')).status).toBe(404);
    expect((await get(`/api/users/${ids.managerB}`, 'ma')).status).toBe(404);
    expect((await get(`/api/users/${ids.admin}`, 'ma')).status).toBe(404);
  });
});

describe('admin scope', () => {
  it('can list and read everyone but has no direct-reports route', async () => {
    expect(emailsOf(await get('/api/users', 'admin'))).toHaveLength(6);
    expect((await get(`/api/users/${ids.devB1}`, 'admin')).status).toBe(200);
    expect((await get('/api/users/direct-reports', 'admin')).status).toBe(403);
  });
});

describe('information hygiene', () => {
  it('returns an identical 404 for "exists but forbidden" and "does not exist"', async () => {
    const forbidden = await get(`/api/users/${ids.devB1}`, 'a1');
    const missing = await get('/api/users/11111111-1111-4111-8111-111111111111', 'a1');

    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect((forbidden.body as ApiErrorBody).error).toEqual((missing.body as ApiErrorBody).error);
  });

  it('rejects a malformed id with 400', async () => {
    expect((await get('/api/users/not-a-uuid', 'a1')).status).toBe(400);
  });

  it('never exposes password hashes', async () => {
    const res = await get('/api/users', 'admin');

    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });
});
