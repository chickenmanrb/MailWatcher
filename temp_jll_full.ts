import type { Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { DealIngestionJob } from '../types.js';
import { FileSystemMonitor } from '../utils/fileSystemMonitor.js';
import { DownloadMonitor } from '../utils/downloadMonitor.js';

type HandlerCtx = { job: DealIngestionJob; workingDir: string; urls: string[]; downloadsPath?: string };

const env = (...keys: string[]) => {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
};

function firstJllUrl(urls: string[]): string | undefined {
  return urls.find(u => /invest\.jll\.com|login\.jll\.com/i.test(u)) || urls[0];
}

export async function handleJll(page: Page, ctx: HandlerCtx): Promise<string> {
  const startUrl = firstJllUrl(ctx.urls);
  if (!startUrl) throw new Error('JLL handler: no URL provided');

  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  // Navigate to entry URL
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await safeShot(page, path.join(ctx.workingDir, 'jll-01-loaded.png'));

  // 1) Ensure login
  await ensureLogin(page, ctx);
  await page.waitForLoadState('networkidle').catch(() => {});
  await safeShot(page, path.join(ctx.workingDir, 'jll-02-after-login.png'));

  // 2) Complete e-sign if required
  await ensureEsign(page, ctx);
  await page.waitForLoadState('networkidle').catch(() => {});
  await safeShot(page, path.join(ctx.workingDir, 'jll-03-after-esign.png'));

  // 3) Enter/ensure Deal Room
  await ensureDealRoom(page, ctx, startUrl);
  await page.waitForLoadState('networkidle').catch(() => {});
  await safeShot(page, path.join(ctx.workingDir, 'jll-04-deal-room.png'));

  // 4) Consent and Download
  const downloaded = await consentAndDownload(page, ctx, outDir).catch(() => null);
  if (downloaded) return outDir;

  // Fallback: attempt generic download buttons/links
  await tryClickAny(page, [
    'button:has-text("Download")',
    'a:has-text("Download")',
    '[data-test-id*="download"]',
  ]);
  const alt = await captureAnyDownload(page, ctx, outDir).catch(() => null);
  if (alt) return outDir;

  return outDir; // return directory even if empty for uniformity
}

async function ensureLogin(page: Page, ctx: HandlerCtx) {
  if (process.env.JLL_SKIP_LOGIN === 'true') return;
  // Quick detection by domain or presence of username/password fields
  const onLoginDomain = /login\.jll\.com/i.test(page.url());
  const hasUsername = await maybeVisible(page, 'input[type="email"], input[name="username"], input[autocomplete="username"], [role="textbox"][name*="username" i]');
  const hasPassword = await maybeVisible(page, 'input[type="password"], [role="textbox"][name*="password" i]');
  if (!onLoginDomain && !hasUsername && !hasPassword) return; // likely already authenticated

  const username = env('JLL_USERNAME', 'JLL_EMAIL', 'USERNAME', 'USER_EMAIL', 'LOGIN_USER', 'LOGIN_EMAIL', 'EMAIL');
  const password = env('JLL_PASSWORD', 'PASSWORD', 'PASS', 'LOGIN_PASSWORD');
  if (!username || !password) throw new Error('JLL credentials missing. Set JLL_USERNAME/JLL_EMAIL and JLL_PASSWORD in environment.');

  // Username step
  await fillFirst(page, [
    'input[type="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[id*="username" i]',
    'input[name*="username" i]'
  ], username);
  await tryClickAny(page, [
    'button:has-text("Next")',
    'button:has-text("Continue")',
    '[type="submit"]:has-text("Next")'
  ]);
  await page.waitForLoadState('networkidle').catch(() => {});

  // Password step
  await fillFirst(page, [
    'input[type="password"]',
    'input[id*="password" i]'
  ], password);
  await tryClickAny(page, [
    'button:has-text("Sign In")',
    'button:has-text("Log In")',
    'button[type="submit"]'
  ]);

  // Let redirects settle
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function ensureEsign(page: Page, ctx: HandlerCtx) {
  if (process.env.JLL_SKIP_ESIGN === 'true') return;
  // Detect CA/ESign landing
  const likelyEsign = /\/esign/i.test(page.url()) || await maybeVisible(page, '[data-test-id="ca-nda.continue"]');
  if (!likelyEsign) return;

  // Choose "Investor" if present
  await tryClickAny(page, [
    'label:has-text("Investor")',
    'input[type="radio"][value*="investor" i]',
  ]);
  await tryClickAny(page, [
    '[data-test-id="ca-nda.continue"]',
    'button:has-text("Continue")'
  ]);

  // Prepare for popup
  const popupP = page.waitForEvent('popup', { timeout: 12000 }).catch(() => null);
  await tryClickAny(page, [
    '[data-test-id="ca-nda.sign-agreement"]',
    'button:has-text("Sign Agreement")',
    'button:has-text("Sign")'
  ]);
  const popup = await popupP;
  const signingPage = popup || page;

  // LHP-like signing flow (from recorded notes)
  await tryClickAny(signingPage, [
    '[data-testid="lhp-continue-btn"]',
    'button:has-text("Continue")'
  ]);

  await tryClickAny(signingPage, [
    '[data-testid="floating-panel-action-button"]',
    'button:has-text("Sign")',
    'button:has-text("Start")'
  ]);

  await tryClickAny(signingPage, [
    '[data-testid="signature-form-field"]',
    '[data-test-id="signature-form-field"]'
  ]);

  const esignName = env('JLL_ESIGN_NAME', 'FULL_NAME', 'USER_NAME', 'NAME') || '';
  if (esignName) {
    await fillFirst(signingPage, [
      '[data-test-id="type-sign-canvas"]',
      'input[name*="signature" i]'
    ], esignName).catch(() => {});
    await tryClickAny(signingPage, [
      '[data-test-id="apply-btn"]',
      'button:has-text("Apply")',
      'button:has-text("Adopt")'
    ]);
  }

  const title = env('JLL_TITLE', 'TITLE', 'USER_TITLE') || '';
  const company = env('JLL_COMPANY', 'COMPANY', 'USER_COMPANY') || '';
  if (title) await fillFirst(signingPage, ['[data-testid="title-field"]', 'input[name*="title" i]'], title).catch(() => {});
  if (company) await fillFirst(signingPage, ['[data-testid="company-field"]', 'input[name*="company" i]'], company).catch(() => {});

  await tryClickAny(signingPage, [
    '[data-testid="footer-submit-button"]',
    'button:has-text("Submit")',
    'button:has-text("Finish")',
    'button:has-text("Complete")'
  ]);

  // Wait for popup to close or navigation back
  if (popup) {
    try { await popup.waitForEvent('close', { timeout: 15000 }); } catch {}
  }
  await page.waitForLoadState('networkidle').catch(() => {});
}

async function ensureDealRoom(page: Page, ctx: HandlerCtx, originalUrl: string) {
  const already = /\/deal-room(\b|\/|\?|#)/i.test(page.url());
  if (already) return;

  // Try to derive deal-room URL from original
  try {
    const u = new URL(originalUrl);
    if (/\/esign/i.test(u.pathname)) {
      const dr = u.href.replace(/\/esign[^?#]*/i, '/deal-room');
      await page.goto(dr, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (/deal-room/i.test(page.url())) return;
    } else if (/\/listings\//i.test(u.pathname) && !/deal-room/i.test(u.pathname)) {
      const dr = u.href.replace(/\/?$/, '') + '/deal-room';
      await page.goto(dr, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if (/deal-room/i.test(page.url())) return;
    }
  } catch {}

  // Try clicking a visible Deal Room entry
  await tryClickAny(page, [
    'a:has-text("Deal Room")',
    'button:has-text("Deal Room")',
    'text=/Deal\s*Room/i'
  ]);
}

async function consentAndDownload(page: Page, ctx: HandlerCtx, outDir: string): Promise<string | null> {
  const context = page.context();

  // Prepare file system monitors (context downloadsPath + OS default)
  const fsMonitors: FileSystemMonitor[] = [];
  const matchers: (RegExp | ((name: string) => boolean))[] = [/\.zip$/i, /download/i, () => true];
  const common = {
    stagingDir: outDir,
    matchers,
    appearTimeoutMs: 60_000,
    stableTimeoutMs: 120_000,
    forceZipExtension: true
  };
  if (ctx.downloadsPath) fsMonitors.push(new FileSystemMonitor({ ...common, downloadsDir: ctx.downloadsPath }));
  fsMonitors.push(new FileSystemMonitor({ ...common }));
  for (const m of fsMonitors) await m.initBaseline();

  // Capture downloads from Playwright too
  const downloads: any[] = [];
  const onDownload = (d: any) => downloads.push(d);
  page.on('download', onDownload);

  // Try to check consent first
  await ensureConsentChecked(page);

  // Race FS monitors with Playwright
  const fsPromises = fsMonitors.map(async (m) => {
    try {
      const p = await m.captureDownload();
      return { type: 'fs' as const, path: p };
    } catch { return null; }
  });
  const pwPromise = page.waitForEvent('download', { timeout: 60_000 })
    .then(d => ({ type: 'pw' as const, download: d }))
    .catch(() => null);

  // Click the JLL download button
  await tryClickAny(page, [
    '[data-test-id="deal-room-download"]',
    'button:has-text("Download")',
    'button:has-text("Create Zip")',
    'a:has-text("Download")'
  ]);

  // Wait for winner
  let winner: any = await Promise.race([pwPromise, ...fsPromises]);
  if (!winner) {
    const all = await Promise.all([pwPromise, ...fsPromises]);
    winner = all.find(Boolean) as any;
  }
  page.off('download', onDownload);

  if (!winner) return null;

  if (winner.type === 'fs') return winner.path;

  const download = winner.download || downloads[0];
  if (!download) return null;
  const suggested = download.suggestedFilename();
  const to = path.join(outDir, suggested || 'bundle.zip');
  try {
    await download.saveAs(to);
    return to;
  } catch {
    try { await download.saveAs(path.join(outDir, 'bundle.zip')); return path.join(outDir, 'bundle.zip'); } catch { return null; }
  }
}

async function ensureConsentChecked(page: Page) {
  // Obvious checkboxes
  await setCheckboxes(page, [
    'input[type="checkbox"][name*="agree" i]','input[type="checkbox"][id*="agree" i]',
    'input[type="checkbox"][name*="terms" i]','input[type="checkbox"][id*="terms" i]',
    'input[type="checkbox"][name*="confidential" i]','input[type="checkbox"][id*="confidential" i]'
  ]);
  // Labels with agreement-like text
  for (const frame of page.frames()) {
    await frame.evaluate((patStr: string) => {
      const pat = new RegExp(patStr, 'i');
      const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
      for (const lb of labels) {
        const txt = (lb.innerText || lb.textContent || '').trim();
        if (txt && pat.test(txt)) {
          try { lb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); (lb as any).click?.(); } catch {}
        }
      }
    }, '(agree|accept|terms|privacy|nda|confidential|consent)').catch(() => {});
  }
  // Try clicking CSS-module checkbox overlays (best effort)
  await tryClickAny(page, [
    '[class*="checkbox_"]',
    '[class*="checkbox"]'
  ]);
}

async function setCheckboxes(page: Page, selectors: string[]) {
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      await frame.evaluate((s) => {
        const el = document.querySelector(s) as HTMLInputElement | null;
        if (!el) return false;
        if (el.type === 'checkbox' && !el.checked) {
          el.checked = true;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
        return false;
      }, sel).catch(() => false);
    }
  }
}

async function captureAnyDownload(page: Page, ctx: HandlerCtx, outDir: string) {
  const context = page.context();
  const d = await page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  if (!d) return null;
  const name = d.suggestedFilename();
  const dest = path.join(outDir, name || 'bundle.zip');
  try { await d.saveAs(dest); return dest; } catch { return null; }
}

async function maybeVisible(page: Page, selector: string): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    const count = await loc.count();
    if (count === 0) return false;
    return await loc.first().isVisible();
  } catch { return false; }
}

async function fillFirst(page: Page, selectors: string[], value: string) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if (await loc.count() === 0) continue;
    try { await loc.fill(value, { timeout: 2000 }); return; } catch {}
    try { await loc.click({ timeout: 1000 }); await loc.fill(''); await loc.type(value, { delay: 10 }); return; } catch {}
  }
}

async function tryClickAny(page: Page, selectors: string[]) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() === 0) continue;
      if (!(await loc.isVisible().catch(() => false))) continue;
      await loc.click({ timeout: 2000 }).catch(async () => { try { await loc.dispatchEvent('click'); } catch {} });
      await page.waitForTimeout(200);
      return true;
    } catch {}
  }
  // Try within frames
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      try {
        const el = await frame.$(sel);
        if (!el) continue;
        const vis = await (el as any).isVisible?.().catch(() => true);
        if (vis === false) continue;
        try { await frame.evaluate((node: Element) => (node as HTMLElement).click?.(), el); } catch {}
        await page.waitForTimeout(200);
        return true;
      } catch {}
    }
  }
  return false;
}

async function safeShot(page: Page, filePath: string) {
  try { await page.screenshot({ path: filePath, fullPage: true }); } catch {}
}

