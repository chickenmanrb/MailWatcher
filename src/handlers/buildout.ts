import type { Page } from 'playwright';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';
import type { DealIngestionJob } from '../types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function handleBuildout(page: Page, ctx: { job: DealIngestionJob; workingDir: string; urls: string[] }) {
  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  // 1) Navigate to NDA / agreement if present
  const target = ctx.urls.find(u => /buildout\.com/i.test(u)) ?? ctx.urls[0];
  await page.goto(target, { waitUntil: 'domcontentloaded' });

  // 2) NDA flows: look for common patterns
  await clickIfExists(page, 'button:has-text("I Agree"), button:has-text("Accept"), text=Confidentiality');

  // 3) Wait for the data room landing; try a few selectors
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(()=>{});

  // 4) Prefer a "Download All" if present
  const archive = await clickDownloadAll(page, [
    'button:has-text("Download All")',
    'a:has-text("Download All")',
    'button[aria-label="Download All"]'
  ], outDir).catch(() => null);

  if (archive) return outDir;

  // 5) Fallback: enumerate file links in a documents grid/list
  await enumerateFileLinks(page, [
    'a[href*="download"]',
    'a:has-text("Download")',
    'a[href$=".pdf"], a[href$=".zip"], a[href$=".xlsx"], a[href$=".docx"]'
  ], outDir);

  return outDir;
}

async function clickIfExists(page: Page, selector: string) {
  const el = await page.$(selector);
  if (el) await el.click();
}

