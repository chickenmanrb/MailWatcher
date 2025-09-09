import { Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function clickDownloadAll(page: Page, buttonSelectorCandidates: string[], outDir: string) {
  await fs.mkdir(outDir, { recursive: true });

  // Find a working selector
  const sel = await resolveSelector(page, buttonSelectorCandidates);
  if (!sel) throw new Error('No Download All button found');
  const [ download ] = await Promise.all([
    page.waitForEvent('download', { timeout: 45_000 }).catch(() => null),
    page.click(sel)
  ]);

  if (download) {
    const suggested = sanitize(await download.suggestedFilename());
    const to = path.join(outDir, suggested || `bundle.zip`);
    await download.saveAs(to);
    return to;
  }

  // If platform streams many files instead of a single archive: capture from browser’s downloads dir
  // Fallback: enumerateFileLinks(...) below
  return null;
}

export async function enumerateFileLinks(page: Page, linkSelectorCandidates: string[], outDir: string) {
  await fs.mkdir(outDir, { recursive: true });
  const selector = await resolveSelector(page, linkSelectorCandidates);
  if (!selector) throw new Error('No file links found');

  const hrefs = await page.$$eval(selector, as => as.map(a => (a as any).href).filter(Boolean));
  const unique = Array.from(new Set(hrefs));

  // Right-click "save link as" is not available; we open and wait for download
  const saved: string[] = [];
  for (const href of unique) {
    const [ download ] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
      page.evaluate((u) => ((globalThis as any).window as any).location.href = u, href)
    ]);
    if (download) {
      const to = path.join(outDir, sanitize(await download.suggestedFilename()));
      await download.saveAs(to);
      saved.push(to);
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(()=>{});
    }
  }
  return saved;
}

async function resolveSelector(page: Page, candidates: string[]) {
  for (const sel of candidates) {
    const el = await page.$(sel);
    if (el) return sel;
  }
  return null;
}

function sanitize(s?: string) {
  return (s || 'file').replace(/[^a-z0-9-_.]+/gi, '_');
}

