import type { Page } from 'playwright';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';
import type { DealIngestionJob } from '../types.js';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function handleGeneric(page: Page, ctx: { job: DealIngestionJob; workingDir: string; urls: string[] }) {
  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  const url = ctx.urls[0];
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(()=>{});

  const archive = await clickDownloadAll(page, [
    'button:has-text("Download All")',
    'a:has-text("Download All")'
  ], outDir).catch(() => null);

  if (archive) return outDir;

  await enumerateFileLinks(page, [
    'a[href*="download"]',
    'a:has-text("Download")',
    'a[href$=".pdf"], a[href$=".zip"], a[href$=".xlsx"], a[href$=".docx"]'
  ], outDir);

  return outDir;
}

