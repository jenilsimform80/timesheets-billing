import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildTestApp,
  createTestPrisma,
  createUser,
  loginToken,
  resetDatabase,
  TEST_PASSWORD,
  type ApiErrorBody,
  accessCookie,
} from './helpers.js';

const prisma = createTestPrisma();
const app = buildTestApp(prisma);
const NEW_PASSWORD = 'Another-Strong-Pass-5';

let adminCookie: string;
let adminId: string;
let n = 0;

beforeAll(async () => {
  await resetDatabase(prisma);
  adminId = (await createUser(prisma, { email: 'admin@t.dev', role: 'ADMIN' })).id;
  adminCookie = await loginToken(app, 'admin@t.dev');
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const fresh = () => `u${++n}`;
const manager = (over = {}) =>
  createUser(prisma, { email: `${fresh()}@t.dev`, role: 'MANAGER', ...over });
const contributor = (managerId: string, over = {}) =>
  createUser(prisma, { email: `${fresh()}@t.dev`, managerId, ...over });

const asAdmin = {
  patch: (id: string, body: object) =>
    request(app).patch(`/api/users/${id}`).set('Cookie', adminCookie).send(body),
  password: (id: string, body: object) =>
    request(app).post(`/api/users/${id}/password`).set('Cookie', adminCookie).send(body),
};
const code = (res: request.Response) => (res.body as ApiErrorBody).error.code;
const row = (id: string) => prisma.user.findUniqueOrThrow({ where: { id } });

describe('PATCH /api/users/:id — who may call it', () => {
  it('rejects anonymous, manager and contributor callers and changes nothing', async () => {
    const m = await manager();
    const c = await contributor(m.id);
    const mCookie = await loginToken(app, m.email);
    const cCookie = await loginToken(app, c.email);

    expect((await request(app).patch(`/api/users/${c.id}`).send({ name: 'X' })).status).toBe(401);
    for (const cookie of [mCookie, cCookie]) {
      const res = await request(app)
        .patch(`/api/users/${c.id}`)
        .set('Cookie', cookie)
        .send({ name: 'Hacked' });
      expect(res.status).toBe(403);
    }
    expect((await row(c.id)).name).not.toBe('Hacked');
  });
});

describe('PATCH /api/users/:id — editing', () => {
  it('renames and moves a contributor to another manager', async () => {
    const m1 = await manager();
    const m2 = await manager();
    const c = await contributor(m1.id);

    const res = await asAdmin.patch(c.id, { name: '  Renamed  ', managerId: m2.id });
    expect(res.status).toBe(200);
    expect((res.body as { user: object }).user).toMatchObject({
      name: 'Renamed',
      managerId: m2.id,
      role: 'CONTRIBUTOR',
    });
  });

  it('promotes a contributor to manager (keeping their manager) and back', async () => {
    const m = await manager();
    const c = await contributor(m.id);

    const up = await asAdmin.patch(c.id, { role: 'MANAGER' });
    expect(up.status).toBe(200);
    expect((await row(c.id)).managerId).toBe(m.id);

    expect((await asAdmin.patch(c.id, { managerId: null })).status).toBe(200);
    expect((await asAdmin.patch(c.id, { role: 'CONTRIBUTOR' })).status).toBe(422);
    const down = await asAdmin.patch(c.id, { role: 'CONTRIBUTOR', managerId: m.id });
    expect(down.status).toBe(200);
    expect((await row(c.id)).managerId).toBe(m.id);
  });

  it('never returns or changes the password hash, and rejects unknown fields', async () => {
    const m = await manager();
    const c = await contributor(m.id);
    const before = (await row(c.id)).passwordHash;
    const ok = await asAdmin.patch(c.id, { name: 'Pat Example' });
    expect(JSON.stringify(ok.body)).not.toMatch(/hash|argon/i);
    expect((await row(c.id)).passwordHash).toBe(before);

    for (const bad of [{ email: 'x@t.dev' }, { passwordHash: 'x' }, { role: 'ADMIN' }]) {
      expect((await asAdmin.patch(c.id, bad)).status).toBe(400);
    }
    expect((await asAdmin.patch(c.id, {})).status).toBe(400);
  });

  it('returns 404 for an unknown user and 400 for a malformed id', async () => {
    expect(
      (await asAdmin.patch('00000000-0000-4000-8000-000000000000', { name: 'x' })).status,
    ).toBe(404);
    expect((await asAdmin.patch('nope', { name: 'x' })).status).toBe(400);
  });

  it('refuses to edit an admin (including the caller themself)', async () => {
    for (const body of [{ isActive: false }, { name: 'Boss' }]) {
      const res = await asAdmin.patch(adminId, body);
      expect(res.status).toBe(422);
      expect(code(res)).toBe('BUSINESS_RULE_VIOLATION');
    }
    expect((await row(adminId)).isActive).toBe(true);
  });
});

describe('PATCH /api/users/:id — manager integrity', () => {
  it('refuses a manager that is inactive, missing, a contributor, or the user themself', async () => {
    const m = await manager();
    const gone = await manager({ isActive: false });
    const c = await contributor(m.id);
    const other = await contributor(m.id);

    for (const bad of [gone.id, other.id, c.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await asAdmin.patch(c.id, { managerId: bad });
      expect(res.status).toBe(422);
    }
    expect((await row(c.id)).managerId).toBe(m.id);
  });

  it('lets a manager report to another manager, but refuses loops and a contributor without one', async () => {
    const m = await manager();
    const other = await manager();
    const c = await contributor(m.id);
    expect((await asAdmin.patch(m.id, { managerId: other.id })).status).toBe(200);
    expect((await row(m.id)).managerId).toBe(other.id);
    // other -> m would close the loop other -> m -> other; self-management is refused too.
    expect((await asAdmin.patch(other.id, { managerId: m.id })).status).toBe(422);
    expect((await asAdmin.patch(other.id, { managerId: other.id })).status).toBe(422);
    expect((await row(other.id)).managerId).toBeNull();
    expect((await asAdmin.patch(c.id, { managerId: null })).status).toBe(422);
  });

  it('refuses to deactivate or demote a manager who still has active reports', async () => {
    const m = await manager();
    await contributor(m.id);

    for (const body of [{ isActive: false }, { role: 'CONTRIBUTOR', managerId: m.id }]) {
      const res = await asAdmin.patch(m.id, body);
      expect(res.status).toBe(422);
    }
    const stored = await row(m.id);
    expect(stored.isActive).toBe(true);
    expect(stored.role).toBe('MANAGER');
  });

  it('allows deactivating a manager whose only reports are inactive', async () => {
    const m = await manager();
    await contributor(m.id, { isActive: false });
    expect((await asAdmin.patch(m.id, { isActive: false })).status).toBe(200);
  });

  it('after reassigning the reports the manager can be deactivated', async () => {
    const m = await manager();
    const m2 = await manager();
    const c = await contributor(m.id);
    expect((await asAdmin.patch(m.id, { isActive: false })).status).toBe(422);
    expect((await asAdmin.patch(c.id, { managerId: m2.id })).status).toBe(200);
    expect((await asAdmin.patch(m.id, { isActive: false })).status).toBe(200);
  });

  it('serializes concurrent "deactivate manager" and "assign a report to them"', async () => {
    for (let i = 0; i < 4; i++) {
      const m = await manager();
      const c = await contributor((await manager()).id);
      const [deactivate, assign] = await Promise.all([
        asAdmin.patch(m.id, { isActive: false }),
        asAdmin.patch(c.id, { managerId: m.id }),
      ]);
      // Exactly one outcome is allowed; never an inactive manager with an active report.
      const reports = await prisma.user.count({ where: { managerId: m.id, isActive: true } });
      const managerActive = (await row(m.id)).isActive;
      expect(managerActive || reports === 0).toBe(true);
      expect([deactivate.status, assign.status].filter((s) => s === 200)).not.toHaveLength(0);
    }
  });
});

describe('deactivating and reactivating', () => {
  it('ends the user’s sessions at once and blocks new logins', async () => {
    const m = await manager();
    const c = await contributor(m.id);
    const cookie = await loginToken(app, c.email);
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);

    expect((await asAdmin.patch(c.id, { isActive: false })).status).toBe(200);

    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect(await prisma.session.count({ where: { userId: c.id } })).toBe(0);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: c.email, password: TEST_PASSWORD });
    expect(login.status).toBe(401);
  });

  it('reactivating restores login; a contributor needs an active manager to come back', async () => {
    const m = await manager();
    const c = await contributor(m.id);
    await asAdmin.patch(c.id, { isActive: false });
    expect((await asAdmin.patch(c.id, { isActive: true })).status).toBe(200);
    expect(
      (await request(app).post('/api/auth/login').send({ email: c.email, password: TEST_PASSWORD }))
        .status,
    ).toBe(200);

    const stranded = await contributor((await manager({ isActive: false })).id, {
      isActive: false,
    });
    expect((await asAdmin.patch(stranded.id, { name: 'Still renamable' })).status).toBe(200);
    expect((await asAdmin.patch(stranded.id, { isActive: true })).status).toBe(422);
  });
});

describe('POST /api/users/:id/password (admin reset)', () => {
  it('rejects non-admins', async () => {
    const m = await manager();
    const c = await contributor(m.id);
    const cookie = await loginToken(app, m.email);
    expect((await request(app).post(`/api/users/${c.id}/password`).send({})).status).toBe(401);
    const res = await request(app)
      .post(`/api/users/${c.id}/password`)
      .set('Cookie', cookie)
      .send({ password: NEW_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('sets the new password, ends old sessions and stops the old password working', async () => {
    const m = await manager();
    const c = await contributor(m.id);
    const oldCookie = await loginToken(app, c.email);

    expect((await asAdmin.password(c.id, { password: NEW_PASSWORD })).status).toBe(204);

    expect((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).status).toBe(401);
    const old = await request(app)
      .post('/api/auth/login')
      .send({ email: c.email, password: TEST_PASSWORD });
    expect(old.status).toBe(401);
    const fresh = await request(app)
      .post('/api/auth/login')
      .send({ email: c.email, password: NEW_PASSWORD });
    expect(fresh.status).toBe(200);
  });

  it('refuses a short password, extra fields, unknown users and admin targets', async () => {
    const m = await manager();
    expect((await asAdmin.password(m.id, { password: 'short' })).status).toBe(400);
    expect((await asAdmin.password(m.id, { password: NEW_PASSWORD, extra: 1 })).status).toBe(400);
    expect(
      (await asAdmin.password('00000000-0000-4000-8000-000000000000', { password: NEW_PASSWORD }))
        .status,
    ).toBe(404);
    expect((await asAdmin.password(adminId, { password: NEW_PASSWORD })).status).toBe(422);
  });
});

describe('forced password change after an admin reset', () => {
  const loginAfterReset = async () => {
    const m = await manager();
    const c = await contributor(m.id);
    await asAdmin.password(c.id, { password: NEW_PASSWORD });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: c.email, password: NEW_PASSWORD });
    return { c, cookie: accessCookie(res), res };
  };

  it('flags the user at login and refuses every route except /me and change-password', async () => {
    const { cookie, res } = await loginAfterReset();
    expect((res.body as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(
      true,
    );
    expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(200);
    for (const path of ['/api/projects', '/api/timesheets/2026-03-02', '/api/submissions']) {
      const blocked = await request(app).get(path).set('Cookie', cookie);
      expect(blocked.status, path).toBe(403);
      expect((blocked.body as ApiErrorBody).error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    }
  });

  it('lifts the restriction once the user chooses their own password', async () => {
    const { c, cookie } = await loginAfterReset();
    const changed = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', cookie)
      .send({ currentPassword: NEW_PASSWORD, newPassword: 'My-Own-Password-9' });
    expect(changed.status).toBe(204);
    expect((await request(app).get('/api/projects').set('Cookie', cookie)).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: c.id } })).mustChangePassword).toBe(
      false,
    );
  });

  it('does not flag users nobody reset', async () => {
    const m = await manager();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: m.email, password: TEST_PASSWORD });
    expect((res.body as { user: { mustChangePassword: boolean } }).user.mustChangePassword).toBe(
      false,
    );
  });

  it('audits who reset whose password, without storing the password', async () => {
    const m = await manager();
    const c = await contributor(m.id);
    await asAdmin.password(c.id, { password: NEW_PASSWORD });
    const rows = await prisma.auditLog.findMany({
      where: { action: 'PASSWORD_RESET', entityId: c.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: adminId, entityType: 'user' });
    expect(JSON.stringify(rows[0])).not.toContain(NEW_PASSWORD);
  });
});

describe('POST /api/auth/change-password (self)', () => {
  const change = (cookie: string | undefined, body: object) => {
    const req = request(app).post('/api/auth/change-password');
    return (cookie ? req.set('Cookie', cookie) : req).send(body);
  };

  it('requires a session', async () => {
    expect(
      (await change(undefined, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD }))
        .status,
    ).toBe(401);
  });

  it('refuses a wrong current password and leaves the password unchanged', async () => {
    const m = await manager();
    const cookie = await loginToken(app, m.email);
    const res = await change(cookie, {
      currentPassword: 'wrong-wrong-wrong',
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(
      (await request(app).post('/api/auth/login').send({ email: m.email, password: TEST_PASSWORD }))
        .status,
    ).toBe(200);
  });

  it('refuses a weak or unchanged new password', async () => {
    const m = await manager();
    const cookie = await loginToken(app, m.email);
    expect(
      (await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: 'short' })).status,
    ).toBe(400);
    expect(
      (await change(cookie, { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD })).status,
    ).toBe(422);
  });

  it('changes the password, keeps this session and ends the others', async () => {
    const m = await manager();
    const here = await loginToken(app, m.email);
    const elsewhere = await loginToken(app, m.email);

    const res = await change(here, { currentPassword: TEST_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(204);

    expect((await request(app).get('/api/auth/me').set('Cookie', here)).status).toBe(200);
    expect((await request(app).get('/api/auth/me').set('Cookie', elsewhere)).status).toBe(401);
    expect(
      (await request(app).post('/api/auth/login').send({ email: m.email, password: TEST_PASSWORD }))
        .status,
    ).toBe(401);
    expect(
      (await request(app).post('/api/auth/login').send({ email: m.email, password: NEW_PASSWORD }))
        .status,
    ).toBe(200);
  });
});
