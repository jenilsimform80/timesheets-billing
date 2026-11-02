import { expect, test } from '@playwright/test';
import {
  appGoto,
  createEntry,
  createProject,
  newSession,
  nav,
  uniqueCode,
} from './support/helpers';
import { readFileSync } from 'node:fs';

/** The hours report can be downloaded as a PDF from a real browser session. */
test.describe('report PDF download', () => {
  const ids = { projectId: '', taskId: '' };

  test.beforeAll(async ({ browser }) => {
    const admin = await newSession(browser, 'admin');
    Object.assign(ids, await createProject(admin.api, uniqueCode('PDF')));
    await admin.context.close();
    const dev = await newSession(browser, 'dev1');
    await createEntry(dev.api, { ...ids, workDate: '2027-11-16', hours: 6 });
    await dev.context.close();
  });

  test('Download PDF saves a real PDF named after the period, containing the report', async ({
    browser,
  }) => {
    const { context, page } = await newSession(browser, 'dev1');
    await appGoto(page, '/reports');
    await page.getByLabel('From', { exact: true }).fill('2027-11-01');
    await page.getByLabel('To', { exact: true }).fill('2027-11-30');
    await page.getByRole('button', { name: 'Run report' }).click();
    await expect(page.getByRole('region', { name: 'Report results' })).toContainText(
      'November 2027',
    );

    // Layout: "Run report" at the left and "Download PDF" at the right end of the same row.
    const run = (await page.getByRole('button', { name: 'Run report' }).boundingBox())!;
    const pdf = (await page.getByRole('button', { name: 'Download PDF' }).boundingBox())!;
    expect(Math.abs(run.y - pdf.y)).toBeLessThan(20);
    expect(pdf.x).toBeGreaterThan(run.x + run.width + 200);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    const file = await download;

    expect(file.suggestedFilename()).toBe('hours-report_2027-11-01_to_2027-11-30.pdf');
    const path = await file.path();
    const text = readFileSync(path, 'latin1');
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text).toContain('Hours report');
    expect(text).toContain('November 2027');
    await expect(nav(page, 'Reports')).toBeVisible(); // the page itself did not navigate away
    await context.close();
  });
});
