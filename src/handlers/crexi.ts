import type { Page } from 'playwright';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';
import type { DealIngestionJob } from '../types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function handleCrexi(page: Page, ctx: { job: DealIngestionJob; workingDir: string; urls: string[] }) {
  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  const url = ctx.urls.find(u => /crexi\.com/i.test(u)) ?? ctx.urls[0];
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // NDA / CA: Crexi often uses modals with "Agree" or "Accept"
  await page.waitForLoadState('networkidle').catch(()=>{});
  await clickIfExists(page, 'button:has-text("Agree")');
  await clickIfExists(page, 'button:has-text("Accept")');
  await clickIfExists(page, 'text=/Confidential/i');

  // Access documents tab
  await clickIfExists(page, 'button:has-text("Documents"), [role="tab"]:has-text("Documents"), a:has-text("Documents")');
  await page.waitForLoadState('networkidle').catch(()=>{});

  const archive = await clickDownloadAll(page, [
    'button:has-text("Download All")',
    '[data-testid="download-all"]'
  ], outDir).catch(() => null);

  if (archive) return outDir;

  await enumerateFileLinks(page, [
    '[data-testid="doc-download"] a[href]',
    'a:has-text("Download")',
    'a[href*="/download"]'
  ], outDir);

  return outDir;
}

async function clickIfExists(page: Page, selector: string) {
  const el = await page.$(selector);
  if (el) await el.click();
}

