import { expect, test } from '@playwright/test';
import {
  USERS,
  createEntry,
  createProject,
  newSession,
  apiOrigin,
  appGoto,
  apiLogin,
  nav,
  uiSignOut,
  uniqueCode,
} from './support/helpers';

/** Security properties of the integrated system, checked from a real browser session. */

test.describe('security', () => {
  const code = uniqueCode('SEC');
  const data = { projectId: '', taskId: '', dev2Entry: '', dev2Id: '' };

  test.beforeAll(async ({ browser }) => {
    const admin = await newSession(browser, 'admin');
    const ids = await createProject(admin.api, code);
    Object.assign(data, ids);
    await admin.context.close();
    const dev2 = await newSession(browser, 'dev2');
    data.dev2Id = (
      (await (await dev2.api.get('/api/auth/me')).json()) as { user: { id: string } }
    ).user.id;
    data.dev2Entry = await createEntry(dev2.api, {
      ...ids,
      workDate: '2027-02-02',
      hours: 3,
      notes: 'private to dev2',
    });
    await dev2.context.close();
  });

  test('every API area refuses anonymous callers', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: apiOrigin() });
    for (const path of [
      '/api/users',
      '/api/projects',
      '/api/time-entries?from=2027-01-01&to=2027-01-31',
      '/api/timesheets/2027-02-01',
      '/api/submissions',
      '/api/locked-periods',
      '/api/audit-logs',
      '/api/reports/hours?from=2027-01-01&to=2027-01-31&groupBy=month',
      '/api/reports/project-budgets',
    ]) {
      const res = await anonymous.get(path);
      expect(res.status(), path).toBe(401);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'UNAUTHENTICATED',
      );
    }
    await anonymous.dispose();
  });

  test('tokens are HttpOnly cookies: invisible to JavaScript and web storage, a reload stays signed in, a new tab shares the session', async ({
    browser,
  }) => {
    const { context, page } = await newSession(browser, 'dev1');

    const visible = await page.evaluate(() => ({
      cookie: document.cookie,
      local: JSON.stringify({ ...localStorage }),
      session: JSON.stringify({ ...sessionStorage }),
    }));
    expect(visible.cookie).toBe(''); // HttpOnly: document.cookie cannot see them
    expect(visible.local).not.toMatch(/eyJ|token/i);
    expect(visible.session).not.toMatch(/eyJ|token/i);

    const cookies = await context.cookies();
    const access = cookies.find((c) => /^(__Host-)?at$/.test(c.name));
    const refresh = cookies.find((c) => /^(__Secure-)?rt$/.test(c.name));
    expect(access, 'access cookie').toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(refresh, 'refresh cookie').toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
      path: '/api/auth',
    });
    expect(cookies.every((c) => c.httpOnly)).toBe(true);

    await page.reload(); // the cookies survive a reload: still signed in
    await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

    const otherTab = await context.newPage(); // cookies are shared by the whole browser profile
    await otherTab.goto('/');
    await expect(otherTab.getByRole('button', { name: 'Account menu' })).toBeVisible();
    await context.close();
  });

  test('signing out ends the session on the server: copied cookies are dead', async ({
    browser,
    playwright,
  }) => {
    // Sign in through the API, then copy the cookie values, exactly like an attacker who stole them.
    const victim = await playwright.request.newContext({ baseURL: apiOrigin() });
    await apiLogin(victim, USERS.dev1);
    const jar = (await victim.storageState()).cookies;
    const value = (pattern: RegExp) => jar.find((c) => pattern.test(c.name))!;
    const stolenAccess = value(/^(__Host-)?at$/);
    const stolenRefresh = value(/^(__Secure-)?rt$/);
    const asStolen = (cookie: { name: string; value: string }) =>
      playwright.request.newContext({
        baseURL: apiOrigin(),
        extraHTTPHeaders: { Cookie: `${cookie.name}=${cookie.value}` },
      });
    const withAccess = await asStolen(stolenAccess);
    const withRefresh = await asStolen(stolenRefresh);
    expect((await withAccess.get('/api/auth/me')).status()).toBe(200);

    const out = await victim.post('/api/auth/logout');

    expect(out.status()).toBe(204);
    expect((await withAccess.get('/api/auth/me')).status()).toBe(401); // JWT unexpired, session gone
    expect((await withRefresh.post('/api/auth/refresh')).status()).toBe(401);
    await withAccess.dispose();
    await withRefresh.dispose();
    await victim.dispose();

    // And through the UI: Sign out clears the cookies, so even a reload stays signed out.
    const { context, page } = await newSession(browser, 'dev1');
    await uiSignOut(page);
    expect((await context.cookies()).filter((c) => c.value !== '')).toEqual([]);
    await appGoto(page, '/timesheet');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await context.close();
  });

  test('a contributor cannot read or change another contributor’s entry, even with the exact id', async ({
    browser,
  }) => {
    const dev1 = await newSession(browser, 'dev1');
    const api = dev1.api;
    expect((await api.get(`/api/time-entries/${data.dev2Entry}`)).status()).toBe(404);
    expect(
      (await api.patch(`/api/time-entries/${data.dev2Entry}`, { data: { hours: 1 } })).status(),
    ).toBe(404);
    expect((await api.delete(`/api/time-entries/${data.dev2Entry}`)).status()).toBe(404);
    const list = await api.get('/api/time-entries?from=2027-02-01&to=2027-02-28');
    expect(((await list.json()) as { entries: unknown[] }).entries).toHaveLength(0);
    expect((await api.get(`/api/users/${data.dev2Id}`)).status()).toBe(404);
    expect(
      (
        await api.get(`/api/time-entries?from=2027-02-01&to=2027-02-28&userId=${data.dev2Id}`)
      ).status(),
    ).toBe(404);
    await dev1.context.close();
  });

  test('managers see their reports only; admin-only APIs are 403 for everyone else', async ({
    browser,
  }) => {
    const other = await newSession(browser, 'otherManager');
    expect((await other.api.get(`/api/time-entries/${data.dev2Entry}`)).status()).toBe(404); // not their report
    const users = (await (await other.api.get('/api/users')).json()) as {
      users: { email: string }[];
    };
    expect(users.users.map((u) => u.email)).toEqual([USERS.otherManager]); // only themself
    await other.context.close();

    for (const who of ['dev1', 'manager'] as const) {
      const s = await newSession(browser, who);
      for (const [method, path] of [
        ['GET', '/api/audit-logs'],
        ['GET', '/api/reports/project-budgets'],
        ['POST', '/api/locked-periods'],
        ['POST', '/api/projects'],
      ] as const) {
        const res = method === 'GET' ? await s.api.get(path) : await s.api.post(path, { data: {} });
        expect(res.status(), `${who} ${method} ${path}`).toBe(403);
      }
      await s.context.close();
    }
  });

  test('admins cannot approve while the owner has a manager; only that manager can', async ({
    browser,
  }) => {
    const dev1 = await newSession(browser, 'dev1');
    await createEntry(dev1.api, {
      projectId: data.projectId,
      taskId: data.taskId,
      workDate: '2027-03-02',
      hours: 2,
    });
    const sub = await dev1.api.post('/api/submissions', {
      data: { weekStart: '2027-03-01' },
    });
    expect(sub.status()).toBe(201);
    const id = ((await sub.json()) as { submission: { id: string } }).submission.id;
    await dev1.context.close();

    const admin = await newSession(browser, 'admin');
    expect((await admin.api.post(`/api/submissions/${id}/approve`, { data: {} })).status()).toBe(
      404,
    );
    await admin.context.close();
    const other = await newSession(browser, 'otherManager');
    expect((await other.api.post(`/api/submissions/${id}/approve`, { data: {} })).status()).toBe(
      404,
    );
    await other.context.close();
    const manager = await newSession(browser, 'manager');
    expect((await manager.api.post(`/api/submissions/${id}/approve`, { data: {} })).status()).toBe(
      200,
    );
    await manager.context.close();
  });

  test('CSRF: the browser sends cookies by itself, so a foreign Origin is refused even with valid cookies', async ({
    browser,
  }) => {
    const { context, api } = await newSession(browser, 'dev1');

    // What a malicious page's form post looks like to the server: valid cookies, foreign Origin.
    const forged = await api.post('/api/auth/logout', {
      headers: { Origin: 'https://evil.example' },
    });
    const forgedWrite = await api.post('/api/time-entries', {
      data: {
        projectId: data.projectId,
        taskId: data.taskId,
        workDate: '2027-04-06',
        hours: 1,
        isBillable: true,
      },
      headers: { Origin: 'https://evil.example' },
    });

    expect(forged.status()).toBe(403);
    expect(forgedWrite.status()).toBe(403);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    expect((await api.get('/api/auth/me')).status()).toBe(200); // the session was NOT ended
    await context.close();
  });

  test('screens hide what a role cannot use, and guarded pages say so', async ({ browser }) => {
    const manager = await newSession(browser, 'manager');
    await appGoto(manager.page, '/');
    await expect(nav(manager.page, 'Approvals')).toBeVisible();
    await expect(nav(manager.page, 'Locked periods')).toHaveCount(0);
    await appGoto(manager.page, '/periods');
    await expect(manager.page.getByText("You don't have access to this page")).toBeVisible();
    await manager.context.close();

    const dev = await newSession(browser, 'dev1');
    await appGoto(dev.page, '/approvals');
    await expect(dev.page.getByText("You don't have access to this page")).toBeVisible();
    await appGoto(dev.page, '/projects');
    await expect(dev.page.getByText('Budget')).toHaveCount(0); // allocated hours are admin-only
    await dev.context.close();
  });

  test('user-supplied text is rendered as text, never executed', async ({ browser }) => {
    const dev = await newSession(browser, 'dev1');
    const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    await createEntry(dev.api, {
      projectId: data.projectId,
      taskId: data.taskId,
      workDate: '2027-05-18',
      hours: 1,
      notes: payload,
    });

    await appGoto(dev.page, '/timesheet?week=2027-05-17');

    await expect(dev.page.getByText(payload, { exact: true })).toBeVisible();
    expect(
      await dev.page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    await expect(dev.page.locator('main img')).toHaveCount(0);
    await dev.context.close();
  });

  test('hostile input is answered with 4xx (NUL bytes, oversized and malformed bodies), never 500', async ({
    browser,
  }) => {
    const { context, api } = await newSession(browser, 'dev1');
    const entry = {
      projectId: data.projectId,
      taskId: data.taskId,
      workDate: '2027-06-08',
      hours: 1,
      isBillable: true,
    };

    expect(
      (await api.post('/api/time-entries', { data: { ...entry, notes: 'a\u0000b' } })).status(),
    ).toBe(400);
    expect(
      (
        await api.post('/api/time-entries', { data: { ...entry, notes: 'x'.repeat(200_000) } })
      ).status(),
    ).toBe(413);
    expect(
      (
        await api.post('/api/time-entries', {
          headers: { 'Content-Type': 'application/json' },
          data: '{"a":',
        })
      ).status(),
    ).toBe(400);
    expect((await api.get('/api/projects/%00')).status()).toBe(400);
    expect((await api.get('/api/timesheets/9999-12-27')).status()).toBe(400);
    expect((await api.get('/api/auth/me')).status()).toBe(200); // the session survived all of that
    await context.close();
  });

  test('API responses are not cacheable', async ({ browser }) => {
    const { context, api } = await newSession(browser, 'admin');
    const res = await api.get('/api/projects');

    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['vary']).toMatch(/Cookie/i);
    expect(res.headers()['etag']).toBeUndefined();
    expect(res.headers()['x-powered-by']).toBeUndefined();
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    await context.close();
  });

  test('wrong-password login does not reveal whether the account exists', async ({ page }) => {
    const attempt = async (email: string) => {
      await page.goto('/login');
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill('wrong-wrong-wrong');
      await page.getByRole('button', { name: 'Sign in' }).click();
      return (await page.getByRole('alert').textContent()) ?? '';
    };

    expect(await attempt(USERS.dev1)).toBe(await attempt('nobody@example.com'));
  });
});
