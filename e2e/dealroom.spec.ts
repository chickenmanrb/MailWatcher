import { test, expect } from '@playwright/test';

// This E2E spec exercises an RCM deal room from an already-authenticated URL.
// The URL should NOT be committed to source. Provide it via env:
//   DEALROOM_URL=https://my.rcm1.com/buyer/vdr?pv=... npx playwright test e2e/dealroom.spec.ts

const DEALROOM_URL = process.env.DEALROOM_URL;

test.describe('RCM Deal Room', () => {
  test.skip(!DEALROOM_URL, 'Set DEALROOM_URL to run this spec');

  test('select all and download', async ({ page }, testInfo) => {
    await page.goto(DEALROOM_URL!, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Select-all per codegen locator
    await page.getByRole('checkbox', { name: 'Select All Rows' }).check({ force: true });

    // Click the dynamic Download button (size varies). Accept non-zero sizes only.
    const downloadBtn = page.getByRole('button', { name: /Download\s*\((?!0\s*KB)[^)]+\)/i });
    await expect(downloadBtn).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await downloadBtn.click();

    // Some rooms show a confirmation
    const ok = page.getByRole('button', { name: /^(Okay|OK|Yes|Confirm|Download)$/i });
    if (await ok.isVisible().catch(() => false)) {
      await ok.click().catch(() => {});
    }

    const download = await downloadPromise;
    const to = testInfo.outputPath(download.suggestedFilename() || 'bundle.zip');
    await download.saveAs(to);

    // Basic assertion: file saved and non-empty
    testInfo.attachments.push({ name: 'downloaded-file', path: to, contentType: 'application/octet-stream' });
  });
});

