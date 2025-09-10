import 'dotenv/config';
import { chromium, type Frame } from 'playwright';
import { createBrowserContext } from '../browser/session.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { handleRcm } from '../handlers/rcm.js';
import { handleCrexi } from '../handlers/crexi.js';
import { handleBuildout } from '../handlers/buildout.js';
import { handleGeneric } from '../handlers/generic.js';
import type { DealIngestionJob } from '../types.js';

type Args = {
  url: string;
  first?: string;
  last?: string;
  name?: string;
  email?: string;
  company?: string;
  title?: string;
  phone?: string;
  handler?: 'rcm' | 'crexi' | 'buildout' | 'generic';
  taskName?: string;
};

function parseArgs(): Args {
  const get = (k: string) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
  const url = get('url') || process.env.MANUAL_URL || '';
  if (!url) throw new Error('Missing --url (or set MANUAL_URL)');
  const handler = (process.argv.includes('--rcm') && 'rcm')
    || (process.argv.includes('--crexi') && 'crexi')
    || (process.argv.includes('--buildout') && 'buildout')
    || (process.argv.includes('--generic') && 'generic')
    || (get('platform') as any);
  return {
    url,
    first: get('first') || process.env.USER_FIRST_NAME || 'William',
    last: get('last') || process.env.USER_LAST_NAME || 'Cromartie',
    name: get('name') || process.env.USER_NAME || 'W. Ross Cromartie',
    email: get('email') || process.env.USER_EMAIL || 'test@example.com',
    company: get('company') || process.env.USER_COMPANY || 'Odyssey Residential Holdings',
    title: get('title') || process.env.USER_TITLE || 'Analyst',
    phone: get('phone') || process.env.USER_PHONE || '(555) 123-4567'
    ,handler,
    taskName: get('task') || get('task_name')
  };
}

async function runManual() {
  const args = parseArgs();
  if (args.handler) return await runManualHandler(args);
  const host = safeHost(args.url) || 'manual';
  const browser = await chromium.launch({ headless: false });
  // Prepare artifacts directory
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const workingDir = path.join('runs', `manual-${host}-${ts}`);
  await fs.mkdir(workingDir, { recursive: true });

  const ctx = await createBrowserContext(browser, host, {
    recordHar: { path: path.join(workingDir, 'network.har'), content: 'embed' }
  });
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await ctx.newPage();

  const logPath = path.join(workingDir, 'log.txt');
  const log = async (line: string) => {
    const stamp = new Date().toISOString();
    await fs.appendFile(logPath, `[${stamp}] ${line}\n`, 'utf8');
  };
  const snap = async (name: string) => {
    const p = path.join(workingDir, `${name}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch(()=>{});
  };
  const dom = async (name: string) => {
    try {
      const html = await page.content();
      await fs.writeFile(path.join(workingDir, `${name}.html`), html, 'utf8');
    } catch {}
  };

  console.log(`[manual] navigating to ${args.url}`);
  await log(`navigate ${args.url}`);
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(()=>{});
  await snap('01-loaded');
  await dom('01-loaded');

  // Ensure agreement/consent checkboxes are checked BEFORE any submit
  await ensureAgreementChecked(page, log);
  // Some flows require clicking an "I Agree" button after the checkbox
  await jsClickByText(page, ['I Agree', 'Accept', 'Agree']);
  await jsClickSelector(page, [
    'button:has-text("I Agree")',
    'button:has-text("Accept")',
    'text=/Agree|Accept/i'
  ]);
  await page.waitForTimeout(500);
  await log('after consent click attempt');
  await snap('02-after-consent');
  await dom('02-after-consent');

  // Fill fields heuristically
  await maybeFill(page, [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[aria-label*="email" i]',
    'input[placeholder*="email" i]'
  ], args.email, log);

  await maybeFill(page, [
    'input[name*="first" i]',
    'input[id*="first" i]',
    'input[placeholder*="first" i]'
  ], args.first, log);

  await maybeFill(page, [
    'input[name*="last" i]',
    'input[id*="last" i]',
    'input[placeholder*="last" i]'
  ], args.last, log);

  await maybeFill(page, [
    // Full name as fallback (avoid overwriting first/last if both present)
    'input[name*="name" i]:not([name*="first" i]):not([name*="last" i])',
    'input[placeholder*="name" i]:not([placeholder*="first" i]):not([placeholder*="last" i])'
  ], args.name, log);

  await maybeFill(page, [
    'input[name*="company" i], input[name*="organization" i]',
    'input[id*="company" i], input[id*="organization" i]',
    'input[aria-label*="company" i], input[aria-label*="organization" i]',
    'input[placeholder*="company" i], input[placeholder*="organization" i]'
  ], args.company, log);

  await maybeFill(page, [
    'input[name*="title" i], input[name*="job" i], input[name*="position" i]',
    'input[placeholder*="title" i], input[placeholder*="job" i], input[placeholder*="position" i]'
  ], args.title, log);

  await maybeFill(page, [
    'input[type="tel"]',
    'input[name*="phone" i], input[name*="mobile" i], input[name*="cell" i]',
    'input[id*="phone" i], input[id*="mobile" i], input[id*="cell" i]',
    'input[aria-label*="phone" i], input[aria-label*="mobile" i], input[aria-label*="cell" i]',
    'input[placeholder*="phone" i], input[placeholder*="mobile" i], input[placeholder*="cell" i]'
  ], args.phone, log);

  await log('after fills');
  await snap('03-after-fill');
  await blurAndTriggerValidation(page, log);
  await log('after blur/validation trigger');
  await snap('03b-after-blur');
  await dom('03b-after-blur');

  const hasErrors = await hasValidationErrors(page, log);
  if (hasErrors) {
    await log('validation errors detected; skipping submit. Inspect page and adjust inputs.');
    console.log('[manual] validation errors detected; not submitting. Inspect the page.');
  } else {
    // Prefer JS clicks for stubborn buttons (but only AFTER ensuring checkboxes are checked)
    let submitted = await jsClickByText(page, ['Submit', 'Continue', 'Request Access', 'Download', 'Apply', 'Get Access']);
    if (!submitted) {
      submitted = await jsClickSelector(page, [
        'button[type="submit"], input[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Continue")',
        'button:has-text("Request Access")',
        'button:has-text("Download")',
      ]);
    }
    if (submitted) {
      console.log('[manual] submit clicked; waiting for network idle');
      await log('submit clicked');
      await snap('04-before-wait');
      await dom('04-before-wait');
      await page.waitForLoadState('networkidle').catch(()=>{});
      await snap('05-after-submit');
      await dom('05-after-submit');
    } else {
      await log('submit button not found or not clickable');
      console.log('[manual] submit button not found/clickable.');
    }
  }
  await dom('03-after-fill');

  // Tick common consent checkboxes
  await clickIfExists(page, 'input[type="checkbox"][name*="agree" i]');
  await clickIfExists(page, 'input[type="checkbox"][name*="terms" i]');

  // Attempt submit

  try {
    await log(`final url: ${page.url()}`);
    await log(`title: ${await page.title()}`);
  } catch {}
  console.log(`[manual] artifacts in ${workingDir}`);
  console.log('[manual] keeping browser open for training. Press Ctrl+C to exit.');
  // On Ctrl+C, save trace and close cleanly
  process.on('SIGINT', async () => {
    try { await ctx.tracing.stop({ path: path.join(workingDir, 'trace.zip') }); } catch {}
    try { await ctx.close(); } catch {}
    try { await browser.close(); } catch {}
    process.exit(0);
  });
  await new Promise(() => {});
}

async function runManualHandler(args: Args) {
  const host = safeHost(args.url) || 'manual';
  const browser = await chromium.launch({ headless: false });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const workingDir = path.join('runs', `manual-flow-${args.handler}-${host}-${ts}`);
  await fs.mkdir(workingDir, { recursive: true });

  const ctx = await createBrowserContext(browser, host, {
    recordHar: { path: path.join(workingDir, 'network.har'), content: 'embed' }
  });
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await ctx.newPage();

  const job: DealIngestionJob = {
    task_name: args.taskName || `manual-${args.handler}-${host}`,
    sharepoint_folder_webUrl: undefined,
    email_body: undefined
  } as any;

  const logPath = path.join(workingDir, 'log.txt');
  const log = async (line: string) => {
    const stamp = new Date().toISOString();
    await fs.appendFile(logPath, `[${stamp}] ${line}\n`, 'utf8');
  };
  const snap = async (name: string) => {
    const p = path.join(workingDir, `${name}.png`);
    await page.screenshot({ path: p, fullPage: true }).catch(()=>{});
  };
  const dom = async (name: string) => {
    try {
      const html = await page.content();
      await fs.writeFile(path.join(workingDir, `${name}.html`), html, 'utf8');
    } catch {}
  };

  await log(`manual-handler start platform=${args.handler} url=${args.url}`);
  await snap('00-start');

  let downloadedRoot: string | undefined;
  try {
    switch (args.handler) {
      case 'rcm':
        downloadedRoot = await handleRcm(page, { job, workingDir, urls: [args.url] });
        break;
      case 'crexi':
        downloadedRoot = await handleCrexi(page, { job, workingDir, urls: [args.url] });
        break;
      case 'buildout':
        downloadedRoot = await handleBuildout(page, { job, workingDir, urls: [args.url] });
        break;
      default:
        downloadedRoot = await handleGeneric(page, { job, workingDir, urls: [args.url] });
    }
    await log(`handler completed downloadedRoot=${downloadedRoot || ''}`);
  } catch (err: any) {
    await log(`handler error: ${err?.message || String(err)}`);
  }

  await snap('99-end');
  await dom('99-end');
  console.log(`[manual] artifacts in ${workingDir}`);

  process.on('SIGINT', async () => {
    try { await ctx.tracing.stop({ path: path.join(workingDir, 'trace.zip') }); } catch {}
    try { await ctx.close(); } catch {}
    try { await browser.close(); } catch {}
    process.exit(0);
  });
  await new Promise(() => {});
}

async function maybeFill(page: import('playwright').Page, selectors: string[], value?: string, log?: (s:string)=>Promise<void>) {
  if (!value) return false;
  for (const sel of selectors) {
    for (const frame of page.frames()) {
      const el = await frame.$(sel);
      if (el) {
        try {
          await el.fill(value, { timeout: 3000 });
          const where = frame === page.mainFrame() ? 'main' : `frame:${frame.url()}`;
          console.log(`[manual] filled ${sel} in ${where} with '${value}'`);
          if (log) await log(`filled ${sel} in ${where} with '${value}'`);
          return true;
        } catch {}
      }
    }
  }
  return false;
}

// dom helper is scoped inside runManual

async function clickIfExists(page: import('playwright').Page, selector: string) {
  try {
    for (const frame of page.frames()) {
      const el = await frame.$(selector);
      if (el) {
        await el.click({ timeout: 3000 }).catch(async () => {
          const loc = frame.locator(selector).first();
          if (await loc.count()) await loc.click({ timeout: 3000 });
        });
        const where = frame === page.mainFrame() ? 'main' : `frame:${frame.url()}`;
        console.log(`[manual] clicked ${selector} in ${where}`);
        return true;
      }
    }
    return false;
  } catch { return false; }
}

async function jsSetCheckbox(page: import('playwright').Page, selectors: string[]) {
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const did = await frame.evaluate((s) => {
        const el = document.querySelector(s) as HTMLInputElement | null;
        if (!el) return false;
        try {
          if (el.type === 'checkbox') {
            el.checked = true;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        } catch {}
        return false;
      }, sel).catch(() => false);
      if (did) return true;
    }
  }
  return false;
}

async function jsClickSelector(page: import('playwright').Page, selectors: string[]) {
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const el = await frame.$(sel);
      if (!el) continue;
      const ok = await frame.evaluate((node: Element) => {
        try {
          const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          node.dispatchEvent(evt);
          (node as HTMLElement).click?.();
          return true;
        } catch { return false; }
      }, el).catch(() => false);
      if (ok) return true;
    }
  }
  return false;
}

async function jsClickByText(page: import('playwright').Page, texts: string[]) {
  for (const frame of page.frames()) {
    const ok = await frame.evaluate((needles: string[]) => {
      const candidates = Array.from(document.querySelectorAll('button, a, label, input[type="button"], input[type="submit"]')) as HTMLElement[];
      for (const n of needles) {
        const re = new RegExp(n, 'i');
        for (const el of candidates) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (txt && re.test(txt)) {
            try {
              const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              el.dispatchEvent(evt);
              el.click?.();
              return true;
            } catch {}
          }
        }
      }
      return false;
    }, texts).catch(() => false);
    if (ok) return true;
  }
  return false;
}

async function ensureAgreementChecked(page: import('playwright').Page, log?: (s:string)=>Promise<void>) {
  const patterns = /(i\s*agree|accept|terms|privacy|nda|confidential|confidentiality|non[-\s]?disclosure|consent)/i;
  let changedAny = false;

  // 1) Check obvious agree/terms checkboxes by selector
  const baseline = await jsSetCheckbox(page, [
    'input[type="checkbox"][name*="agree" i]',
    'input[type="checkbox"][id*="agree" i]',
    'input[type="checkbox"][name*="terms" i]',
    'input[type="checkbox"][id*="terms" i]',
    'input[type="checkbox"][name*="confidential" i]',
    'input[type="checkbox"][id*="confidential" i]'
  ]);
  changedAny = changedAny || baseline;

  // 2) Checkboxes discovered via label text
  for (const frame of page.frames()) {
    const did = await frame.evaluate((patStr: string) => {
      const pat = new RegExp(patStr, 'i');
      let changed = false;
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) as (HTMLInputElement | HTMLElement)[];
      for (const box of boxes) {
        let labelTxt = '';
        const input = box as HTMLInputElement;
        const id = (input as HTMLInputElement).id;
        const byFor = id ? document.querySelector(`label[for="${id}"]`) as HTMLLabelElement | null : null;
        if (byFor && byFor.innerText) labelTxt += ' ' + byFor.innerText;
        const closestLabel = box.closest('label') as HTMLLabelElement | null;
        if (closestLabel && closestLabel.innerText) labelTxt += ' ' + closestLabel.innerText;
        const aria = (box.getAttribute('aria-label') || '') + ' ' + (box.getAttribute('aria-labelledby') || '');
        labelTxt += ' ' + aria;
        const surrounding = (box.parentElement?.textContent || '').slice(0, 500);
        labelTxt += ' ' + surrounding;

        if (pat.test(labelTxt)) {
          try {
            if ((box as HTMLInputElement).type === 'checkbox') {
              const cb = box as HTMLInputElement;
              if (!cb.checked) {
                cb.checked = true;
                cb.dispatchEvent(new Event('input', { bubbles: true }));
                cb.dispatchEvent(new Event('change', { bubbles: true }));
                changed = true;
              }
            } else if (box.getAttribute('role') === 'checkbox') {
              if (box.getAttribute('aria-checked') !== 'true') {
                box.setAttribute('aria-checked', 'true');
                box.dispatchEvent(new Event('input', { bubbles: true }));
                box.dispatchEvent(new Event('change', { bubbles: true }));
                // Fire a click to satisfy frameworks
                box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                changed = true;
              }
            }
          } catch {}
        }
      }
      // Also click labels that read like agreement
      const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
      for (const lb of labels) {
        const txt = (lb.innerText || lb.textContent || '').trim();
        if (txt && pat.test(txt)) {
          try {
            lb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            (lb as HTMLElement).click?.();
            changed = true;
          } catch {}
        }
      }
      return changed;
    }, patterns.source).catch(() => false);
    if (did) changedAny = true;
  }

  if (changedAny && log) await log('agreement/consent checkbox set via JS');
  return changedAny;
}

async function blurAndTriggerValidation(page: import('playwright').Page, log?: (s:string)=>Promise<void>) {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(() => {
        const fields = Array.from(document.querySelectorAll('input, textarea, select')) as HTMLElement[];
        for (const el of fields) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        (document.activeElement as HTMLElement | null)?.blur?.();
      });
    } catch {}
  }
  try { await page.mouse.click(2, 2); } catch {}
  await page.waitForTimeout(300);
  if (log) await log('triggered blur/change on inputs and clicked outside');
}

async function hasValidationErrors(page: import('playwright').Page, log?: (s:string)=>Promise<void>) {
  let found = false;
  const messages: string[] = [];
  for (const frame of page.frames()) {
    try {
      const res = await frame.evaluate(() => {
        const msgs: string[] = [];
        const collectText = (sel: string) => Array.from(document.querySelectorAll(sel)).map(e => (e as HTMLElement).innerText || (e as HTMLElement).textContent || '').map(s => s.trim()).filter(Boolean);
        const push = (arr: string[]) => { for (const s of arr) if (s) msgs.push(s); };
        push(collectText('[role="alert"]'));
        push(collectText('.error, .errors, .invalid-feedback, .validation-error, .field-error, .help-block, .ant-form-item-explain-error, .MuiFormHelperText-root.Mui-error, .error-message'));
        // Inputs marked invalid
        const invalids: string[] = [];
        const inputs = Array.from(document.querySelectorAll('input, textarea, select')) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
        for (const el of inputs) {
          const ai = el.getAttribute('aria-invalid');
          const bad = ai === 'true' || (typeof (el as any).checkValidity === 'function' && !(el as any).checkValidity());
          if (bad) {
            const label = el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('aria-label') || el.placeholder || el.tagName;
            const msg = (el as any).validationMessage || '';
            invalids.push(`${label}${msg ? `: ${msg}` : ''}`);
          }
        }
        msgs.push(...invalids);
        return msgs.slice(0, 10);
      });
      if (res && res.length) {
        found = true;
        messages.push(...res);
      }
    } catch {}
  }
  if (found && log) await log(`validation errors: ${messages.join(' | ').slice(0, 500)}`);
  return found;
}

function safeHost(u: string) {
  try { return new URL(u).hostname.replace(/[^a-z0-9.-]+/gi, '_').toLowerCase(); } catch { return undefined; }
}

runManual().catch(err => { console.error(err); process.exit(1); });
