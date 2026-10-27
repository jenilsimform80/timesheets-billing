import { expect, test } from '@playwright/test';
import { appGoto, newSession } from './support/helpers';

/**
 * Every screen must work under the strict Content-Security-Policy the production web server sends
 * (`frontend/nginx/security-headers.conf`: no inline scripts, no inline styles). The browser reports
 * each blocked resource as a `securitypolicyviolation` event; there must be none. (Mutation-checked: raw
 * markup with a style attribute is caught as `style-src-attr`. React `style` props go through the CSSOM,
 * which CSP does not govern, so they are not flagged.)
 * In the plain dev setup there is no CSP, so the test only checks the screens render; set
 * E2E_EXPECT_CSP=1 when running against the production-like stack to also require the header.
 */
test('every screen renders without a single CSP violation', async ({ browser }) => {
  const { context, page } = await newSession(browser, 'admin');
  const violations: string[] = [];
  const errors: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`,
      );
    });
  });
  page.on('pageerror', (e) => errors.push(e.message));

  const collect = async () => {
    violations.push(
      ...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)),
    );
  };

  // A full page load: the only way to read the response headers. Then move around without
  // reloading (faster).
  const landing = await page.goto('/');
  if (process.env['E2E_EXPECT_CSP'] === '1') {
    const csp = landing?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(landing?.headers()['x-content-type-options']).toBe('nosniff');
    expect(landing?.headers()['referrer-policy']).toBe('no-referrer');
  }
  // The cookies survived the full page load, so the session is still signed in.
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

  for (const [path, heading] of [
    ['/', /Welcome/],
    ['/timesheet?week=2027-02-01', 'Timesheet'],
    ['/projects', 'Projects'],
    ['/reports', 'Hours report'],
    ['/reports/budgets', 'Project budgets'],
    ['/periods', 'Locked periods'],
    ['/approvals', null], // admins get the "no access" panel
    ['/status', 'System status'],
    ['/this/page/does/not/exist', null],
  ] as const) {
    await appGoto(page, path);
    if (heading) await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    else await expect(page.getByRole('main')).toBeVisible();
    await collect();
  }

  expect(errors).toEqual([]);
  expect(violations).toEqual([]);
  await context.close();
});
