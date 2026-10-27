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
let managerId: string;
let inactiveManagerId: string;
let contributorId: string;

const PASSWORD = 'Brand-New-Pass-77';

beforeAll(async () => {
  await resetDatabase(prisma);
  await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' });
  managerId = (await createUser(prisma, { email: 'm@t.dev', role: 'MANAGER' })).id;
  inactiveManagerId = (
    await createUser(prisma, { email: 'gone@t.dev', role: 'MANAGER', isActive: false })
  ).id;
  contributorId = (await createUser(prisma, { email: 'dev@t.dev', managerId })).id;
  for (const who of ['admin', 'm', 'dev']) cookies[who] = await loginToken(app, `${who}@t.dev`);
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const create = (who: string | undefined, body: object) => {
  const req = request(app).post('/api/users');
  return (who ? req.set('Cookie', cookies[who]!) : req).send(body);
};
const code = (res: request.Response) => (res.body as ApiErrorBody).error.code;
const valid = (over: object = {}) => ({
  email: 'new.dev@t.dev',
  name: 'New Dev',
  role: 'CONTRIBUTOR',
  password: PASSWORD,
  managerId,
  ...over,
});

describe('POST /api/users — who may call it', () => {
  it('rejects anonymous callers', async () => {
    expect((await create(undefined, valid())).status).toBe(401);
  });

  it.each(['m', 'dev'])('refuses %s (not an admin) and creates nothing', async (who) => {
    const res = await create(who, valid({ email: `x-${who}@t.dev` }));
    expect(res.status).toBe(403);
    expect(code(res)).toBe('FORBIDDEN');
    expect(await prisma.user.findUnique({ where: { email: `x-${who}@t.dev` } })).toBeNull();
  });
});

describe('POST /api/users — creating accounts', () => {
  it('creates a contributor under a manager, who can then sign in', async () => {
    const res = await create('admin', valid());
    expect(res.status).toBe(201);
    const { user } = res.body as { user: Record<string, unknown> };
    expect(user).toMatchObject({
      email: 'new.dev@t.dev',
      name: 'New Dev',
      role: 'CONTRIBUTOR',
      managerId,
      isActive: true,
    });
    // The hash must never be returned.
    expect(JSON.stringify(res.body)).not.toMatch(/hash|argon|Brand-New/i);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'new.dev@t.dev', password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it('stores a hash, not the password', async () => {
    const row = await prisma.user.findUniqueOrThrow({ where: { email: 'new.dev@t.dev' } });
    expect(row.passwordHash).not.toContain(PASSWORD);
    expect(row.passwordHash.startsWith('$argon2id$')).toBe(true);
  });

  it('creates a manager without a manager; the manager appears in the approvals scope', async () => {
    const res = await create(
      'admin',
      valid({ email: 'new.mgr@t.dev', role: 'MANAGER', managerId: undefined }),
    );
    expect(res.status).toBe(201);
    expect((res.body as { user: { role: string; managerId: unknown } }).user).toMatchObject({
      role: 'MANAGER',
      managerId: null,
    });
  });

  it('creates a manager under another manager (who then approves their timesheet)', async () => {
    const res = await create(
      'admin',
      valid({ email: 'junior.mgr@t.dev', role: 'MANAGER', managerId }),
    );
    expect(res.status).toBe(201);
    expect((res.body as { user: { managerId: unknown } }).user.managerId).toBe(managerId);
  });

  it('lower-cases and trims the email', async () => {
    const res = await create('admin', valid({ email: '  Mixed.Case@T.dev ', name: ' Padded ' }));
    expect(res.status).toBe(201);
    expect((res.body as { user: { email: string; name: string } }).user).toMatchObject({
      email: 'mixed.case@t.dev',
      name: 'Padded',
    });
  });

  it('shows the new user in the admin user list', async () => {
    const res = await request(app).get('/api/users').set('Cookie', cookies['admin']!);
    const emails = (res.body as { users: { email: string }[] }).users.map((u) => u.email);
    expect(emails).toContain('new.dev@t.dev');
  });
});

describe('POST /api/users — rejected input', () => {
  it('refuses a duplicate email with 409, even in a different case', async () => {
    const res = await create('admin', valid({ email: 'DEV@t.dev' }));
    expect(res.status).toBe(409);
    expect(code(res)).toBe('CONFLICT');
  });

  it('refuses to create an admin (role not creatable)', async () => {
    const res = await create('admin', valid({ email: 'root@t.dev', role: 'ADMIN' }));
    expect(res.status).toBe(400);
    expect(await prisma.user.findUnique({ where: { email: 'root@t.dev' } })).toBeNull();
  });

  it('refuses a short password', async () => {
    const res = await create('admin', valid({ email: 'short@t.dev', password: 'short7!' }));
    expect(res.status).toBe(400);
    expect(code(res)).toBe('VALIDATION_ERROR');
  });

  it('enforces the 8-character password minimum exactly (7 refused, 8 accepted)', async () => {
    const seven = await create('admin', valid({ email: 'seven@t.dev', password: '1234567' }));
    expect(seven.status).toBe(400);
    const eight = await create('admin', valid({ email: 'eight@t.dev', password: '12345678' }));
    expect(eight.status).toBe(201);
  });

  it.each([
    ['bad email', { email: 'not-an-email' }],
    ['empty name', { name: '   ' }],
    ['unknown role', { role: 'SUPERUSER' }],
    ['malformed managerId', { managerId: 'nope' }],
    ['contributor without manager', { managerId: undefined }],
    ['unknown field (mass assignment)', { isActive: false, passwordHash: 'x' }],
  ])('refuses %s with 400', async (_label, over) => {
    const res = await create('admin', valid({ email: 'case@t.dev', ...over }));
    expect(res.status).toBe(400);
    expect(code(res)).toBe('VALIDATION_ERROR');
    expect(await prisma.user.findUnique({ where: { email: 'case@t.dev' } })).toBeNull();
  });

  it('refuses a manager that does not exist or is inactive (422)', async () => {
    for (const bad of [inactiveManagerId, '00000000-0000-4000-8000-000000000000']) {
      const res = await create('admin', valid({ email: 'orphan@t.dev', managerId: bad }));
      expect(res.status).toBe(422);
      expect(code(res)).toBe('BUSINESS_RULE_VIOLATION');
    }
  });

  it('refuses a manager that is really a contributor (422)', async () => {
    const res = await create('admin', valid({ email: 'orphan@t.dev', managerId: contributorId }));
    expect(res.status).toBe(422);
    expect(await prisma.user.findUnique({ where: { email: 'orphan@t.dev' } })).toBeNull();
  });
});
