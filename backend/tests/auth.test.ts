import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccessToken } from '../src/auth/access-token.js';
import { createSession, hashToken } from '../src/auth/session.service.js';
import {
  buildTestApp,
  createTestPrisma,
  createUser,
  resetDatabase,
  setCookies,
  TEST_PASSWORD,
  testEnv,
  type ApiErrorBody,
} from './helpers.js';

const prisma = createTestPrisma();
const app = buildTestApp(prisma);

beforeEach(async () => {
  await resetDatabase(prisma);
  await createUser(prisma, { email: 'dev@test.dev', name: 'Dev' });
});
afterAll(async () => {
  await resetDatabase(prisma);
  await prisma.$disconnect();
});

const login = (email = 'dev@test.dev', password = TEST_PASSWORD, target = app) =>
  request(target).post('/api/auth/login').send({ email, password });

/** The raw values of the two token cookies a login/refresh response set. */
const tokensOf = (res: request.Response) => {
  const cookies = setCookies(res);
  return { accessToken: cookies['at'] ?? '', refreshToken: cookies['rt'] ?? '' };
};
const bearer = (res: request.Response) => `at=${tokensOf(res).accessToken}`;
const refreshWith = (refreshToken: string, target = app) =>
  request(target).post('/api/auth/refresh').set('Cookie', `rt=${refreshToken}`);
const setCookieLines = (res: request.Response) => res.headers['set-cookie'] as unknown as string[];

describe('POST /api/auth/login', () => {
  it('returns only the user in the body and sets the tokens as cookies', async () => {
    const res = await login();

    expect(res.status).toBe(200);
    const body = res.body as { user: Record<string, unknown> };
    expect(body.user).toMatchObject({ email: 'dev@test.dev', name: 'Dev', role: 'CONTRIBUTOR' });
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|password_hash|argon2/);
    // JavaScript must not be able to read a token from the response either.
    expect(Object.keys(body)).toEqual(['user']);
    expect(tokensOf(res).accessToken.split('.')).toHaveLength(3); // a JWT
    expect(tokensOf(res).refreshToken).not.toBe('');
  });

  it('sets HttpOnly, SameSite=Lax cookies with the right paths and lifetimes (dev: no Secure)', async () => {
    const lines = setCookieLines(await login());
    const access = lines.find((l) => l.startsWith('at='))!;
    const refresh = lines.find((l) => l.startsWith('rt='))!;

    for (const line of [access, refresh]) {
      expect(line).toMatch(/; HttpOnly/);
      expect(line).toMatch(/; SameSite=Lax/);
      expect(line).not.toMatch(/; Secure/);
      expect(line).not.toMatch(/; Domain=/);
    }
    expect(access).toMatch(/; Path=\/(;|$)/);
    expect(access).toMatch(/; Max-Age=900/);
    expect(refresh).toMatch(/; Path=\/api\/auth(;|$)/); // only sent to the auth endpoints
    expect(refresh).toMatch(/; Expires=/);
  });

  it('in production uses the __Host-/__Secure- prefixes and Secure', async () => {
    const prod = buildTestApp(prisma, { NODE_ENV: 'production' });
    const res = await login('dev@test.dev', TEST_PASSWORD, prod);
    const lines = setCookieLines(res);
    const access = lines.find((l) => l.startsWith('__Host-at='))!;
    const refresh = lines.find((l) => l.startsWith('__Secure-rt='))!;

    expect(access).toMatch(/; Secure/);
    expect(access).toMatch(/; HttpOnly/);
    expect(access).toMatch(/; Path=\/(;|$)/);
    expect(access).not.toMatch(/; Domain=/); // __Host- requires no Domain
    expect(refresh).toMatch(/; Secure/);
    expect(refresh).toMatch(/; HttpOnly/);
    // The plain dev names are not honoured in production (cookie-tossing defence).
    const plain = await request(prod)
      .get('/api/auth/me')
      .set('Cookie', `at=${setCookies(res)['__Host-at']}`);
    expect(plain.status).toBe(401);
    const real = await request(prod)
      .get('/api/auth/me')
      .set('Cookie', `__Host-at=${setCookies(res)['__Host-at']}`);
    expect(real.status).toBe(200);
  });

  it('issues a JWT with only sub and sid claims, signed HS256', async () => {
    const { accessToken } = tokensOf(await login());
    const [header, payload] = accessToken
      .split('.')
      .slice(0, 2)
      .map(
        (part) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>,
      );

    expect(header).toMatchObject({ alg: 'HS256' });
    expect(Object.keys(payload!).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
    expect(JSON.stringify(payload)).not.toContain('dev@test.dev'); // no PII in the token
  });

  it('stores only a hash of the refresh token, and an argon2id password hash', async () => {
    const { refreshToken } = tokensOf(await login());

    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.tokenHash).toBe(hashToken(refreshToken));
    expect(sessions[0]!.tokenHash).not.toContain(refreshToken);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'dev@test.dev' } });
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(user.passwordHash).not.toContain(TEST_PASSWORD);
  });

  it('is case-insensitive on email', async () => {
    expect((await login('  DEV@Test.DEV ')).status).toBe(200);
  });

  it('gives the same 401 for a wrong password, unknown email and inactive user', async () => {
    await createUser(prisma, { email: 'gone@test.dev', isActive: false });

    const wrong = await login('dev@test.dev', 'nope-nope');
    const unknown = await login('nobody@test.dev');
    const inactive = await login('gone@test.dev');

    for (const res of [wrong, unknown, inactive]) {
      expect(res.status).toBe(401);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect(unknown.body).toEqual(wrong.body);
    expect(inactive.body).toEqual(wrong.body);
    expect(await prisma.session.count()).toBe(0);
  });

  it('validates the body', async () => {
    const noPassword = await request(app).post('/api/auth/login').send({ email: 'dev@test.dev' });
    const badEmail = await request(app).post('/api/auth/login').send({ email: 'x', password: 'y' });

    expect(noPassword.status).toBe(400);
    expect((noPassword.body as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    expect(badEmail.status).toBe(400);
  });

  it('creates an independent session per login (two devices stay signed in)', async () => {
    const first = await login();
    const second = await login();

    expect(tokensOf(second).refreshToken).not.toBe(tokensOf(first).refreshToken);
    expect(await prisma.session.count()).toBe(2);
    expect((await request(app).get('/api/auth/me').set('Cookie', bearer(first))).status).toBe(200);
  });
});

describe('login throttling', () => {
  it('blocks further attempts after too many failures, even with the right password', async () => {
    const limited = buildTestApp(prisma, { LOGIN_RATE_LIMIT_MAX: 3 });

    for (let i = 0; i < 3; i++) {
      expect((await login('dev@test.dev', 'wrong', limited)).status).toBe(401);
    }
    const blocked = await login('dev@test.dev', TEST_PASSWORD, limited);

    expect(blocked.status).toBe(429);
    expect((blocked.body as ApiErrorBody).error.code).toBe('RATE_LIMITED');
  });

  it('does not count successful logins', async () => {
    const limited = buildTestApp(prisma, { LOGIN_RATE_LIMIT_MAX: 2 });

    for (let i = 0; i < 5; i++) {
      expect((await login('dev@test.dev', TEST_PASSWORD, limited)).status).toBe(200);
    }
  });
});

describe('GET /api/auth/me', () => {
  it('rejects requests without a cookie', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.status).toBe(401);
    expect((res.body as ApiErrorBody).error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the current user for a valid access cookie', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', bearer(await login()));

    expect(res.status).toBe(200);
    expect((res.body as { user: { email: string } }).user.email).toBe('dev@test.dev');
  });

  it('rejects malformed access cookies', async () => {
    const good = tokensOf(await login()).accessToken;
    for (const header of [
      'at=',
      'at=not-a-jwt',
      `at=${good}x`,
      `at=${good.split('.').slice(0, 2).join('.')}`, // signature removed
      good, // no cookie name
      `other=${good}`,
    ]) {
      expect((await request(app).get('/api/auth/me').set('Cookie', header)).status).toBe(401);
    }
  });

  it('no longer accepts Authorization: Bearer (cookies are the only way in)', async () => {
    const good = tokensOf(await login()).accessToken;

    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${good}`);

    expect(res.status).toBe(401);
  });

  it('rejects the refresh token used as an access token', async () => {
    const { refreshToken } = tokensOf(await login());
    const res = await request(app).get('/api/auth/me').set('Cookie', `at=${refreshToken}`);

    expect(res.status).toBe(401);
  });

  it('rejects a token signed with another secret, an unsigned token, and a tampered payload', async () => {
    const real = tokensOf(await login()).accessToken;
    const claims = {
      userId: (await prisma.user.findFirstOrThrow()).id,
      sessionId: (await prisma.session.findFirstOrThrow()).id,
    };

    const forged = (await signAccessToken('another-secret-another-secret-another', claims, 15))
      .token;
    const [h, p] = real.split('.');
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`;
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'x' })).toString('base64url')}.${real.split('.')[2]}`;

    for (const token of [forged, none, tampered]) {
      expect((await request(app).get('/api/auth/me').set('Cookie', `at=${token}`)).status).toBe(
        401,
      );
    }
  });

  it('rejects an expired access token', async () => {
    const claims = { userId: (await prisma.user.findFirstOrThrow()).id, sessionId: 'x' };
    const { sessionId } = await createSession(prisma, claims.userId, 8);
    const old = new Date(Date.now() - 2 * 3_600_000);
    const { token } = await signAccessToken(testEnv.JWT_SECRET, { ...claims, sessionId }, 15, old);

    expect((await request(app).get('/api/auth/me').set('Cookie', `at=${token}`)).status).toBe(401);
  });

  it('rejects and removes an access token whose session has expired', async () => {
    const auth = bearer(await login());
    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).get('/api/auth/me').set('Cookie', auth);

    expect(res.status).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('rejects a still-valid access token once the user is deactivated', async () => {
    const auth = bearer(await login());
    await prisma.user.updateMany({ data: { isActive: false } });

    expect((await request(app).get('/api/auth/me').set('Cookie', auth)).status).toBe(401);
  });

  it('does not accept the token from a query string, or from the refresh cookie slot', async () => {
    const { accessToken } = tokensOf(await login());

    expect((await request(app).get(`/api/auth/me?access_token=${accessToken}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Cookie', `rt=${accessToken}`)).status).toBe(
      401,
    );
  });
});

describe('POST /api/auth/refresh', () => {
  it('sets a new cookie pair, and the old refresh token stops working (rotation)', async () => {
    const first = tokensOf(await login());

    const res = await refreshWith(first.refreshToken);

    expect(res.status).toBe(200);
    const next = tokensOf(res);
    expect(next.refreshToken).not.toBe(first.refreshToken);
    expect((res.body as { user: Record<string, unknown> }).user).toMatchObject({
      email: 'dev@test.dev',
    });
    expect(Object.keys(res.body as object)).toEqual(['user']);
    expect((await request(app).get('/api/auth/me').set('Cookie', bearer(res))).status).toBe(200);
    expect((await refreshWith(first.refreshToken)).status).toBe(401); // replay of the old one
    expect((await refreshWith(next.refreshToken)).status).toBe(200); // the new one works
    expect(await prisma.session.count()).toBe(1); // same session, rotated in place
  });

  it('lets only one of two concurrent refreshes with the same token succeed', async () => {
    const { refreshToken } = tokensOf(await login());

    const results = await Promise.all([refreshWith(refreshToken), refreshWith(refreshToken)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('does not extend the absolute session lifetime', async () => {
    const { refreshToken } = tokensOf(await login());
    const before = (await prisma.session.findFirstOrThrow()).expiresAt;

    await refreshWith(refreshToken);

    expect((await prisma.session.findFirstOrThrow()).expiresAt).toEqual(before);
  });

  it('rejects unknown, expired and deactivated-user refresh tokens with the same 401', async () => {
    const { refreshToken } = tokensOf(await login());
    const unknown = await refreshWith('not-a-real-refresh-token');

    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await refreshWith(refreshToken);

    const again = tokensOf(await login());
    await prisma.user.updateMany({ data: { isActive: false } });
    const deactivated = await refreshWith(again.refreshToken);

    for (const res of [unknown, expired, deactivated]) {
      expect(res.status).toBe(401);
      expect((res.body as ApiErrorBody).error.code).toBe('UNAUTHENTICATED');
    }
    expect(
      await prisma.session.count({ where: { tokenHash: hashToken(again.refreshToken) } }),
    ).toBe(0);
  });

  it('rejects an access token presented as a refresh token', async () => {
    const { accessToken } = tokensOf(await login());

    expect((await refreshWith(accessToken)).status).toBe(401);
  });

  it('without a refresh cookie is a 401, and ignores a token sent in the body', async () => {
    const { refreshToken } = tokensOf(await login());

    const none = await request(app).post('/api/auth/refresh');
    const viaBody = await request(app).post('/api/auth/refresh').send({ refreshToken });

    expect(none.status).toBe(401);
    expect(viaBody.status).toBe(401);
    expect((await refreshWith(refreshToken)).status).toBe(200); // the real token was not consumed
  });

  it('clears both cookies when the refresh token is dead, so the browser stops sending them', async () => {
    const res = await refreshWith('not-a-real-refresh-token');

    expect(res.status).toBe(401);
    const lines = setCookieLines(res);
    expect(lines.find((l) => l.startsWith('at='))).toMatch(/Expires=Thu, 01 Jan 1970/);
    const refresh = lines.find((l) => l.startsWith('rt='))!;
    expect(refresh).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(refresh).toMatch(/Path=\/api\/auth/);
  });

  it('counts toward the coarse per-IP attempt limit', async () => {
    const limited = buildTestApp(prisma, { LOGIN_ATTEMPT_LIMIT_MAX: 2 });

    expect((await refreshWith('a', limited)).status).toBe(401);
    expect((await refreshWith('b', limited)).status).toBe(401);
    expect((await refreshWith('c', limited)).status).toBe(429);
  });
});

describe('POST /api/auth/logout', () => {
  it('destroys the session server-side: access AND refresh tokens die at once', async () => {
    const res = await login();
    const { refreshToken } = tokensOf(res);

    const out = await request(app).post('/api/auth/logout').set('Cookie', `rt=${refreshToken}`);

    expect(out.status).toBe(204);
    expect(await prisma.session.count()).toBe(0);
    // A copied access cookie is dead even though its JWT has not expired.
    expect((await request(app).get('/api/auth/me').set('Cookie', bearer(res))).status).toBe(401);
    expect((await refreshWith(refreshToken)).status).toBe(401);
  });

  it('clears both cookies in the browser', async () => {
    const { refreshToken } = tokensOf(await login());

    const out = await request(app).post('/api/auth/logout').set('Cookie', `rt=${refreshToken}`);

    const lines = setCookieLines(out);
    expect(lines.find((l) => l.startsWith('at='))).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(lines.find((l) => l.startsWith('rt='))).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('is idempotent and does not reveal whether the token existed', async () => {
    const unknown = await request(app).post('/api/auth/logout').set('Cookie', 'rt=nope');
    const none = await request(app).post('/api/auth/logout');

    expect(unknown.status).toBe(204);
    expect(none.status).toBe(204);
  });

  it("cannot end another user's session without their refresh cookie", async () => {
    await login();

    expect((await request(app).post('/api/auth/logout')).status).toBe(204);
    expect(await prisma.session.count()).toBe(1);
  });
});

describe('CSRF defence (cookies are sent automatically, so the Origin is checked)', () => {
  const origin = 'http://localhost:5173';

  it('refuses a state-changing request from a foreign Origin, even with a valid cookie', async () => {
    const res = await login();

    const evil = await request(app)
      .post('/api/auth/change-password')
      .set('Cookie', bearer(res))
      .set('Origin', 'http://evil.test')
      .send({ currentPassword: TEST_PASSWORD, newPassword: 'Another-Good-Pass-1' });
    const loginEvil = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'http://evil.test')
      .send({ email: 'dev@test.dev', password: TEST_PASSWORD });
    const logoutEvil = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', `rt=${tokensOf(res).refreshToken}`)
      .set('Origin', 'http://evil.test');

    for (const r of [evil, loginEvil, logoutEvil]) {
      expect(r.status).toBe(403);
      expect((r.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
    }
    expect(await prisma.session.count()).toBe(1); // logout was not performed
    const user = await prisma.user.findFirstOrThrow();
    expect(user.mustChangePassword).toBe(false);
  });

  it('allows the configured frontend Origin, safe methods from anywhere, and requests with no Origin', async () => {
    const own = await request(app)
      .post('/api/auth/login')
      .set('Origin', origin)
      .send({ email: 'dev@test.dev', password: TEST_PASSWORD });
    const read = await request(app)
      .get('/api/auth/me')
      .set('Cookie', bearer(own))
      .set('Origin', 'http://evil.test'); // a GET changes nothing; CORS stops evil.test reading it

    expect(own.status).toBe(200);
    expect(own.headers['access-control-allow-origin']).toBe(origin);
    expect(own.headers['access-control-allow-credentials']).toBe('true');
    expect(read.status).toBe(200);
    expect(read.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('varies on Cookie so a shared cache cannot serve one user the answer for another', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.headers['vary']).toMatch(/Cookie/);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});
