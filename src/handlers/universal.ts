import type { Page, Frame } from 'playwright';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';
import type { DealIngestionJob } from '../types.js';
import { loadFormData } from '../config/formData.js';
import { DownloadMonitor } from '../utils/downloadMonitor.js';
import { FileSystemMonitor } from '../utils/fileSystemMonitor.js';
import path from 'node:path';
import fs from 'node:fs/promises';

type AutofillOptions = {
  aggressive?: boolean;      // also check non-required "agree/consent" boxes
  optInMarketing?: boolean;  // check newsletter/marketing boxes too
  submit?: boolean;          // click/submit after filling
  onlyRequired?: boolean;    // fill only required fields
  maxSteps?: number;         // for multi-step forms (next/continue)
  skipSensitive?: boolean;   // don't auto-fill CC/SSN/etc
  debug?: boolean;           // console.log diagnostics
};

const DEFAULTS: AutofillOptions = {
  aggressive: true,
  optInMarketing: false,
  submit: true,
  onlyRequired: false,
  maxSteps: 3,
  skipSensitive: true,
  debug: process.env.UNIVERSAL_DEBUG === 'true',
};

const env = (...keys: string[]) => {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
};

type DataKeys = typeof AUTOCOMPLETE_MAP[keyof typeof AUTOCOMPLETE_MAP] | 'EMAIL' | 'PASSWORD' | 'USERNAME' | 'FULL_NAME' | 'FIRST_NAME' | 'LAST_NAME' | 'COMPANY' | 'TITLE' | 'PHONE' | 'WEBSITE' | 'ADDRESS1' | 'ADDRESS2' | 'CITY' | 'STATE' | 'POSTAL_CODE' | 'COUNTRY';

async function buildDataBucket(): Promise<Record<DataKeys, string | undefined>> {
  const file = await loadFormData().catch(() => ({}));
  const envBucket: Record<DataKeys, string | undefined> = {
    EMAIL: env('EMAIL', 'USER_EMAIL', 'LOGIN_EMAIL'),
    PASSWORD: env('PASSWORD', 'PASS', 'LOGIN_PASSWORD'),
    USERNAME: env('USERNAME', 'LOGIN_USER', 'USER_NAME'),
    FULL_NAME: env('FULL_NAME', 'NAME', 'USER_FULL_NAME'),
    FIRST_NAME: env('FIRST_NAME', 'GIVEN_NAME', 'FNAME', 'USER_FIRST_NAME'),
    LAST_NAME: env('LAST_NAME', 'SURNAME', 'LNAME', 'FAMILY_NAME', 'USER_LAST_NAME'),
    COMPANY: env('COMPANY', 'ORG', 'ORGANIZATION', 'USER_COMPANY', 'COMPANY_NAME'),
    TITLE: env('TITLE', 'JOB_TITLE', 'USER_TITLE'),
    PHONE: env('PHONE', 'MOBILE', 'TEL', 'USER_PHONE'),
    WEBSITE: env('WEBSITE', 'URL', 'HOMEPAGE'),
    ADDRESS1: env('ADDRESS1', 'STREET', 'STREET1'),
    ADDRESS2: env('ADDRESS2', 'APT', 'SUITE', 'UNIT'),
    CITY: env('CITY', 'TOWN'),
    STATE: env('STATE', 'PROVINCE', 'REGION'),
    POSTAL_CODE: env('POSTAL_CODE', 'ZIP', 'ZIPCODE'),
    COUNTRY: env('COUNTRY'),
  } as any;
  // file values take precedence over env
  return { ...envBucket, ...(file as any) };
}

const SENSITIVE = /(ssn|social[\s_-]*security|credit[\s_-]*card|card[\s_-]*number|cc[-_\s]*num|cvv|cvc|security[\s_-]*code|iban|swift|routing|account[\s_-]*number|bank|dob|birth|passport|driver|licen[cs]e)/i;

const AUTOCOMPLETE_MAP: Record<string, keyof typeof DATA> = {
  email: 'EMAIL',
  username: 'USERNAME',
  name: 'FULL_NAME',
  'given-name': 'FIRST_NAME',
  'additional-name': 'FULL_NAME',
  'family-name': 'LAST_NAME',
  organization: 'COMPANY',
  'street-address': 'ADDRESS1',
  'address-line1': 'ADDRESS1',
  'address-line2': 'ADDRESS2',
  'address-level2': 'CITY',
  'address-level1': 'STATE',
  'postal-code': 'POSTAL_CODE',
  country: 'COUNTRY',
  tel: 'PHONE',
  url: 'WEBSITE',
  'current-password': 'PASSWORD',
  'new-password': 'PASSWORD',
};

const SYNONYMS: Array<[keyof typeof DATA, RegExp[]]> = [
  ['EMAIL', [/email|e-?mail/i]],
  ['PASSWORD', [/password|passcode|pwd/i]],
  ['USERNAME', [/user.?name(?!.*(email))/i]],
  ['FIRST_NAME', [/first.*name|given[-\s]?name|^f(?:irst)?name$|^first$/i]],
  ['LAST_NAME', [/last.*name|family[-\s]?name|surname|^l(?:ast)?name$|^last$/i]],
  ['FULL_NAME', [/full.*name\b|(?<!first|last)\bname\b/i]],
  ['COMPANY', [/company|organisation|organization|employer|work.?place|business/i]],
  ['TITLE', [/title|role|position|job.?title/i]],
  ['PHONE', [/phone|mobile|cell|tel|telephone|contact/i]],
  ['WEBSITE', [/website|url|homepage/i]],
  ['ADDRESS1', [/address(?!.*(2|line\s*2))|street|street\s*1|address[-_\s]*line[-_\s]*1/i]],
  ['ADDRESS2', [/address.*(2|line\s*2)|apt|suite|unit/i]],
  ['CITY', [/city|town/i]],
  ['STATE', [/state|province|region/i]],
  ['POSTAL_CODE', [/zip|postal/i]],
  ['COUNTRY', [/country/i]],
];

export async function handleUniversal(page: Page, ctx: { job: DealIngestionJob; workingDir: string; urls: string[] }, opts: AutofillOptions = {}): Promise<string> {
  const options: AutofillOptions = { ...DEFAULTS, ...opts };
  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  const url = ctx.urls[0];
  console.log('Universal Handler: Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('Universal Handler: Page loaded, current URL:', page.url());

  await page.screenshot({ path: path.join(ctx.workingDir, 'universal-01-loaded.png') }).catch(() => {});
  await page.screenshot({ path: path.join(ctx.workingDir, 'universal-before-interaction.png') }).catch(() => {});

  // Pre-consent phase
  await ensureAgreementChecked(page, options);
  await clickCommon(page, ['button:has-text("I Agree")', 'button:has-text("Accept")', 'text=/Agree|Accept/i']);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(ctx.workingDir, 'universal-after-consent.png') }).catch(() => {});

  // Try multi-step autofill/submit up to maxSteps
  for (let step = 0; step < (options.maxSteps || 1); step++) {
    // Re-check consent each step in case of multi-form flows
    console.log('Universal Handler: ensuring consent/agreements before fill (step', step + 1, ')');
    await ensureAgreementChecked(page, options);
    await clickCommon(page, [
      'button:has-text("I Agree")',
      'button:has-text("Accept")',
      'text=/Agree(\s*&\s*Continue)?|Accept(\s*&\s*Continue)?/i'
    ]);
    await page.waitForTimeout(150);

    const DATA = await buildDataBucket();
    const filledCount = await autofillVisibleForms(page, options, DATA);
    console.log(`Universal Handler: autofill step ${step + 1} changed=${filledCount}`);

    // Fallback pass using Playwright for common selectors if nothing changed
    if (!filledCount) {
      const fallback = await autofillFallbackSelectors(page, DATA, options);
      console.log(`Universal Handler: fallback changed=${fallback}`);
    }
    await page.screenshot({ path: path.join(ctx.workingDir, `universal-step-${step + 1}.png`) }).catch(() => {});

    if (!options.submit) break;

    const advanced = await tryAdvance(page);
    if (!advanced && !filled) {
      if (options.debug) console.log('Universal Handler: no advance and no fill; breaking');
      break; // nothing changed, stop looping
    }
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(400);

    // Some flows open a second consent on the next step
    console.log('Universal Handler: ensuring consent/agreements after navigation (step', step + 1, ')');
    await ensureAgreementChecked(page, options);
    await clickCommon(page, [
      'button:has-text("I Agree")',
      'button:has-text("Accept")',
      'text=/Agree(\s*&\s*Continue)?|Accept(\s*&\s*Continue)?/i'
    ]);
    await page.waitForTimeout(200);
  }

  // Try to enter the Deal Room if a link/button appears (may open a popup)
  let activePage = page;
  if (await isDealRoomPage(page)) {
    console.log('Universal Handler: Already in Deal Room; skipping entry step.');
  } else {
    console.log('Universal Handler: Checking for Deal Room entry...');
    activePage = await enterDealRoomIfPresent(page);
  }

  // Try find Documents area and download
  console.log('Universal Handler: Looking for Documents/Files section...');
  await gotoDocuments(activePage);
  await activePage.screenshot({ path: path.join(ctx.workingDir, 'universal-documents.png') }).catch(() => {});
  // RCM-style grids often require selecting files first
  await trySelectAllDocuments(activePage);
  await activePage.screenshot({ path: path.join(ctx.workingDir, 'universal-documents-selected.png') }).catch(() => {});

  // Try the context-specific Download button (e.g., "Download (123 KB)")
  const selectedBundle = await clickDownloadSelected(activePage, outDir, ctx.downloadsPath).catch(() => null);
  if (selectedBundle) return outDir;

  // Otherwise try a visible "Download All" UI
  const archive = await clickDownloadAll(activePage, [
    'button:has-text("Download All")',
    'a:has-text("Download All")',
    'button[title*="Download All"]',
  ], outDir).catch(() => null);
  if (archive) return outDir;

  await enumerateFileLinks(activePage, [
    'a[href*="download"]',
    'a:has-text("Download")',
    'a[href$=".pdf"], a[href$=".zip"], a[href$=".xlsx"], a[href$=".docx"]',
  ], outDir).catch(() => {});
  return outDir;
}

// Subset handler: start at Deal Room part of the flow.
// Skips consent/auto-fill and focuses on entering the room (if needed),
// navigating to Documents/Files and downloading artifacts.
export async function handleUniversalDealroom(page: Page, ctx: { job: DealIngestionJob; workingDir: string; urls: string[]; downloadsPath?: string }): Promise<string> {
  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  const url = ctx.urls[0];
  console.log('Universal Dealroom: Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  console.log('Universal Dealroom: Page loaded, current URL:', page.url());

  await page.screenshot({ path: path.join(ctx.workingDir, 'universal-dr-01-loaded.png') }).catch(() => {});

  // Enter deal room if link/button present (handles popups)
  let activePage = page;
  if (await isDealRoomPage(page)) {
    console.log('Universal Dealroom: Already in Deal Room; skipping entry step.');
  } else {
    console.log('Universal Dealroom: Checking for Deal Room entry...');
    activePage = await enterDealRoomIfPresent(page);
  }
  await activePage.waitForLoadState('networkidle').catch(() => {});
  await activePage.screenshot({ path: path.join(ctx.workingDir, 'universal-dr-02-after-entry.png') }).catch(() => {});

  // Navigate to Documents/Files
  console.log('Universal Dealroom: Looking for Documents/Files section...');
  await gotoDocuments(activePage);
  await activePage.screenshot({ path: path.join(ctx.workingDir, 'universal-dr-02a-before-select.png') }).catch(() => {});
  await activePage.waitForLoadState('networkidle').catch(() => {});
  await activePage.screenshot({ path: path.join(ctx.workingDir, 'universal-dr-03-documents.png') }).catch(() => {});

  // Select all rows and click Download if available
  await trySelectAllDocuments(activePage);
  await activePage.screenshot({ path: path.join(ctx.workingDir, 'universal-dr-03a-selected.png') }).catch(() => {});

  const selectedBundle = await clickDownloadSelected(activePage, outDir, ctx.downloadsPath).catch(() => null);
  if (selectedBundle) return outDir;

  // Try Download All then fallback to enumerating file links
  const archive = await clickDownloadAll(activePage, [
    'button:has-text("Download All")',
    'a:has-text("Download All")',
    'button[title*="Download All"]',
  ], outDir).catch(() => null);
  if (archive) return outDir;

  await enumerateFileLinks(activePage, [
    'a[href*="download"]',
    'a:has-text("Download")',
    'a[href$=".pdf"], a[href$=".zip"], a[href$=".xlsx"], a[href$=".docx"]',
  ], outDir).catch(() => {});
  return outDir;
}

async function gotoDocuments(page: Page) {
  const did = await clickCommon(page, [
    'a:has-text("Documents")',
    '[role="tab"]:has-text("Documents")',
    'a:has-text("Files")',
  ]);
  if (did) {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function clickCommon(page: Page, selectors: string[]) {
  return clickCommonInFrames(page.frames(), selectors);
}

async function clickCommonInFrames(frames: Frame[], selectors: string[]) {
  for (const frame of frames) {
    for (const sel of selectors) {
      const el = await frame.$(sel);
      if (!el) continue;
      try {
        await el.click({ timeout: 2000 }).catch(async () => {
          const ok = await frame.evaluate((node: Element) => {
            try {
              const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              node.dispatchEvent(evt);
              (node as HTMLElement).click?.();
              return true;
            } catch { return false; }
          }, el).catch(() => false);
          if (!ok) throw new Error('js click failed');
        });
        return true;
      } catch {}
    }
  }
  return false;
}

async function trySelectAllDocuments(page: Page) {
  // Prefer role-based locator (from Playwright codegen)
  try {
    const roleExact = page.getByRole('checkbox', { name: 'Select All Rows' });
    await roleExact.first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
    if (await roleExact.count()) {
      try {
        await roleExact.first().check({ force: true, timeout: 2000 });
      } catch {
        try { await roleExact.first().click({ timeout: 1500 }); } catch {}
      }
      await page.waitForTimeout(250);
      console.log('Universal Dealroom: Selected via role=checkbox name="Select All Rows"');
      return true;
    }
    const roleCb = page.getByRole('checkbox', { name: /select all rows/i });
    if (await roleCb.count()) {
      try {
        await roleCb.first().check({ force: true, timeout: 2000 });
      } catch {
        try { await roleCb.first().click({ timeout: 1500 }); } catch {}
      }
      await page.waitForTimeout(250);
      console.log('Universal Dealroom: Selected via role=checkbox regex');
      return true;
    }
  } catch {}

  // Mirror working logic from tests/test-deal-room.js
  const headerCheckboxSelectors = [
    'thead input[type="checkbox"]',
    'th input[type="checkbox"]',
    'input[id*="select-all" i]',
    '.table-header input[type="checkbox"]',
    'input[kendogridselectallcheckbox]',
    'input[type="checkbox"][aria-label*="select all" i]',
    'input[type="checkbox"]:first-of-type'
  ];

  for (const sel of headerCheckboxSelectors) {
    try {
      const headerCheckbox = await page.$(sel);
      if (headerCheckbox) {
        const isVisible = await headerCheckbox.isVisible().catch(() => false);
        if (isVisible) {
          console.log('Universal Dealroom: Clicking header select-all via selector:', sel);
          try {
            await page.evaluate((cb: Element) => (cb as HTMLElement).click(), headerCheckbox);
          } catch {
            try { await page.locator(sel).first().dispatchEvent('click'); } catch {}
          }
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join((page as any)._context?._options?._recordHar?.path ? process.cwd() : '.', 'runs', 'universal-debug-selected.png') }).catch(() => {});
          return true;
        }
      }
    } catch {}
  }

  // Fallback: click all visible checkboxes
  try {
    const checkboxes = await page.$$('input[type="checkbox"], input[aria-label*="Select Row" i]');
    console.log('Universal Dealroom: Fallback checkbox count =', checkboxes.length);
    for (let i = 0; i < checkboxes.length; i++) {
      try {
        const checkbox = checkboxes[i];
        const isVisible = await checkbox.isVisible().catch(() => false);
        if (isVisible) {
          await page.evaluate((cb: Element) => (cb as HTMLElement).click(), checkbox);
          await page.waitForTimeout(120);
        }
      } catch {}
    }
  } catch {}
  return false;
}

async function clickDownloadSelected(page: Page, outDir: string, downloadsPath?: string) {
  // Wait a moment for selections to register
  await page.waitForTimeout(800);

  // For RCM, we need to monitor for downloads at the context level since they may happen in popups
  const context = page.context();
  
  // Initialize FileSystemMonitors BEFORE clicking to capture baseline
  // Monitor both the context downloads directory (if provided) and the OS default/RCM_DOWNLOAD_DIR
  const fsMonitors: FileSystemMonitor[] = [];
  const commonMonitorOpts = {
    stagingDir: outDir,
    matchers: [
      /Unlimited Saving II/i,
      /\.zip$/i,
      /\.csv$/i,
      /\.tmp$/i,
      () => true
    ],
    appearTimeoutMs: 60_000,
    stableTimeoutMs: 120_000,
    forceZipExtension: true
  } as const;
  if (downloadsPath) {
    fsMonitors.push(new FileSystemMonitor({ ...commonMonitorOpts, downloadsDir: downloadsPath }));
  }
  // Always add a monitor for the OS default/RCM_DOWNLOAD_DIR
  fsMonitors.push(new FileSystemMonitor({ ...commonMonitorOpts }));
  for (const m of fsMonitors) {
    console.log('Universal Dealroom: FileSystemMonitor configured', {
      downloadsDir: (m as any).downloadsDir,
      stagingDir: (m as any).stagingDir,
    });
    await m.initBaseline();
  }
  
  // Baseline for monitors already captured above
  
  // Set up Playwright download monitoring as fallback for non-RCM sites
  const downloads: any[] = [];
  const downloadHandler = (download: any) => {
    console.log('Universal Dealroom: Download started:', download.suggestedFilename());
    downloads.push(download);
  };
  context.on('download', downloadHandler);

  // Prepare to capture download BEFORE clicking (context-level to catch popups)
  let downloadPromise = page.context().waitForEvent('download', { timeout: 5_000 }).catch(() => null);

  // Try role-based button name first: Download (<size>)
  let clicked = false;
  const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
  try {
    const dlRole = page.getByRole('button', { name: /download\s*\((?!0\s*kb)[^)]+\)/i });
    if (await dlRole.count()) {
      const loc = dlRole.first();
      if (!(await loc.isDisabled().catch(() => false))) {
        await loc.click({ timeout: 2000 });
        console.log('Universal Dealroom: Clicked Download via role-based locator');
        clicked = true;
      }
    }
  } catch {}

  if (!clicked) {
    const downloadButton = await page.$('button.vdr-download-button:not([disabled]), button:has-text("Download"):not([disabled])');
    if (!downloadButton) return null;
    const isEnabled = await downloadButton.isEnabled().catch(() => false);
    if (!isEnabled) return null;
    try { await page.evaluate((btn: Element) => (btn as HTMLElement).click(), downloadButton); clicked = true; console.log('Universal Dealroom: Clicked Download via selector'); } catch {}
    if (!clicked) { try { await downloadButton.click(); clicked = true; } catch {} }
    if (!clicked) return null;
  }

  // Prepare background capture via FileSystemMonitors (handles silent background downloads)
  const fsCapturePromises = fsMonitors.map(m =>
    m.captureDownload()
     .then(p => ({ type: 'fs' as const, path: p, monitorDir: (m as any).downloadsDir }))
     .catch(err => { console.log('Universal Dealroom: FileSystemMonitor capture error (will fallback):', (m as any).downloadsDir, err?.message || err); return null; })
  );

  // Handle potential confirmation popup without blocking FS monitor
  console.log('Universal Dealroom: Checking for confirmation dialog while monitoring filesystem...');
  await page.waitForTimeout(1500).catch(()=>{});  // brief pause for dialog
  // Screenshot for diagnostics
  await page.screenshot({ path: path.join(path.dirname(outDir), 'universal-after-download-click.png') }).catch(() => {});
  
  const confirmationSelectors = [
    'button:has-text("Okay")',
    'button:has-text("OK")',
    'button:has-text("Ok")',
    'button:has-text("Yes")',
    'button:has-text("Confirm")',
    'button:has-text("Download")',
    'button:has-text("Start")',
    'button:has-text("Proceed")',
    'button:has-text("Create Zip")',
    'button:has-text("Generate")',
    'button:has-text("Prepare")',
    '[role="dialog"] button:has-text("Okay")',
    '[role="dialog"] button:has-text("OK")',
    '[role="dialog"] button:has-text("Ok")',
    '[role="dialog"] button:has-text("Yes")',
    '[role="dialog"] button:has-text("Start")',
    '[role="dialog"] button:has-text("Proceed")',
    '[role="dialog"] button:has-text("Confirm")',
    '[role="dialog"] button:has-text("Download")',
    '[role="dialog"] button:has-text("Create Zip")',
    '[role="dialog"] button:has-text("Generate")',
    '[role="dialog"] button:has-text("Prepare")',
    '.modal button:has-text("Okay")',
    '.modal button:has-text("OK")'
  ];
  for (const selector of confirmationSelectors) {
    try {
      const confirmBtn = await page.$(selector);
      if (confirmBtn && await confirmBtn.isVisible()) {
        try { await page.evaluate((btn: Element) => (btn as HTMLElement).click(), confirmBtn); } catch {}
        break;
      }
      // try within frames
      for (const frame of page.frames()) {
        try {
          const fe = await frame.$(selector);
          if (fe && await fe.isVisible().catch(() => false)) {
            try { await frame.evaluate((btn: Element) => (btn as HTMLElement).click(), fe); } catch {}
            break;
          }
        } catch {}
      }
    } catch {}
  }

  // Try clicking within any visible dialog container for common action buttons
  try {
    const dialogs = page.locator('[role="dialog"], .modal-dialog, .k-dialog, .k-window');
    const count = await dialogs.count();
    for (let i = 0; i < count; i++) {
      const d = dialogs.nth(i);
      if (!(await d.isVisible().catch(() => false))) continue;
      const act = d.locator('button:has-text(/^(Okay|OK|Ok|Yes|Confirm|Proceed|Start|Download|Create|Generate|Prepare)/i)');
      if (await act.count()) {
        await act.first().click({ timeout: 2000 }).catch(async () => {
          try { await act.first().dispatchEvent('click'); } catch {}
        });
        await page.waitForTimeout(500);
        break;
      }
    }
  } catch {}

  // If a popup opened, bring it to front and let confirmations be handled there too
  const popup = await popupPromise;
  if (popup) {
    try { await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
    try { await popup.bringToFront(); } catch {}
  }

  // Race Playwright's download event with FileSystemMonitor captures
  const pwDownloadPromise = page.context().waitForEvent('download', { timeout: 60_000 })
    .then(d => ({ type: 'pw' as const, download: d }))
    .catch(() => null);

  // First winner decides the path forward
  let winner = await Promise.race([pwDownloadPromise, ...fsCapturePromises]);

  // If nothing won the initial race, await whichever completes next
  if (!winner) {
    const results = await Promise.all([pwDownloadPromise, ...fsCapturePromises]);
    winner = results.find(Boolean) as any;
  }

  // Clean up the event listener
  context.off('download', downloadHandler);

  if (winner && winner.type === 'fs') {
    console.log('Universal Dealroom: Download captured via FileSystemMonitor:', winner.path, 'from', (winner as any).monitorDir);
    return winner.path;
  }

  // Playwright download path
  let download = winner && winner.type === 'pw' ? winner.download : null;
  if (!download && downloads.length > 0) {
    download = downloads[0];
    console.log('Universal Dealroom: Using download from event handler');
  }

  if (!download) {
    // Fallback to old DownloadMonitor for backwards compatibility
    console.log('Universal Dealroom: No download captured; falling back to legacy monitor');
    const browserDownloadPath = downloadsPath || 
                                (context as any)._options?.downloadsPath || 
                                path.join(process.cwd(), 'runs', 'downloads-temp', 'my.rcm1.com');
    const monitor = new DownloadMonitor(browserDownloadPath);
    await monitor.initialize();
    const downloadedFile = await monitor.waitForNewDownload({ timeout: 30000, pollInterval: 500 });
    if (downloadedFile) {
      const fileName = path.basename(downloadedFile);
      const destPath = path.join(outDir, fileName);
      try {
        await fs.copyFile(downloadedFile, destPath);
        await fs.unlink(downloadedFile).catch(() => {});
        console.log('Universal Dealroom: Download captured via old monitor:', fileName);
        return destPath;
      } catch (err2) {
        console.log('Universal Dealroom: Error moving download:', err2);
      }
    }
    console.log('Universal Dealroom: No download captured by any method');
    return null;
  }

  const suggested = await download.suggestedFilename().catch(() => 'bundle.zip');
  const to = path.join(outDir, suggested || 'bundle.zip');
  try {
    await download.saveAs(to);
    console.log('Universal Dealroom: Download saved to', to);
  } catch (err) {
    console.log('Universal Dealroom: Error saving download:', err);
    try {
      await download.saveAs(path.join(outDir, 'bundle.zip'));
      console.log('Universal Dealroom: Download saved as bundle.zip');
    } catch (err2) {
      console.log('Universal Dealroom: Failed to save download:', err2);
      return null;
    }
  }
  return to;
}

async function enterDealRoomIfPresent(page: Page): Promise<Page> {
  const candidates = [
    'text=/Continue to Deal\s*Room/i',
    'text=/Enter Deal\s*Room/i',
    'text=/Go to Deal\s*Room/i',
    'text=/Proceed to Deal\s*Room/i',
    'text=/View Deal\s*Room/i',
    'a:has-text("Deal Room")',
    'button:has-text("Deal Room")',
    'text=/Data\s*Room|Deal\s*Center/i'
  ];

  for (const sel of candidates) {
    const el = await page.$(sel);
    if (!el) continue;
    console.log('Universal Handler: Found Deal Room candidate:', sel);
    const popupP = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    const navP = page.waitForNavigation({ timeout: 8000 }).catch(() => null);
    try {
      await page.evaluate((node: Element) => (node as HTMLElement).click(), el);
    } catch {
      try { await el.click({ timeout: 2000 }); } catch {}
    }
    const [popup, nav] = await Promise.all([popupP, navP]);
    if (popup) {
      console.log('Universal Handler: Deal Room opened in popup');
      try { await popup.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
      try { await popup.bringToFront(); } catch {}
      return popup;
    }
    if (nav) {
      console.log('Universal Handler: Navigated to Deal Room in same tab');
      return page;
    }
  }

  // Fallback heuristic: click any element with text or href suggesting Deal/Data Room
  const popupP = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
  const navP = page.waitForNavigation({ timeout: 8000 }).catch(() => null);
  const clicked = await page.evaluate((reStr: string) => {
    const re = new RegExp(reStr, 'i');
    const els = Array.from(document.querySelectorAll('a, button, [role="button"]')) as HTMLElement[];
    for (const el of els) {
      const txt = (el.innerText || el.textContent || '').trim();
      const href = (el as HTMLAnchorElement).href || '';
      if (re.test(txt) || /(deal[-_]?room|data[-_]?room)/i.test(href)) {
        try {
          const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          el.dispatchEvent(evt);
          el.click?.();
          return true;
        } catch {}
      }
    }
    return false;
  }, '(Continue|Enter|Go to|Proceed|View).{0,20}(Deal\\s*Room)|Deal\\s*Room|Data\\s*Room|Deal\\s*Center').catch(() => false);
  const [popup2, nav2] = await Promise.all([popupP, navP]);
  if (popup2) {
    console.log('Universal Handler: Deal Room opened in popup (fallback)');
    try { await popup2.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
    try { await popup2.bringToFront(); } catch {}
    return popup2;
  }
  if (nav2) {
    console.log('Universal Handler: Navigated to Deal Room in same tab (fallback)');
    return page;
  }
  if (clicked) console.log('Universal Handler: Clicked heuristic candidate but no navigation/popup');
  return page;
}

async function isDealRoomPage(page: Page): Promise<boolean> {
  try {
    const url = page.url();
    if (/\/buyer\/vdr|deal\s*room|data\s*room/i.test(url)) return true;
  } catch {}

  for (const frame of page.frames()) {
    const hit = await frame.evaluate(() => {
      const bodyText = (document.body?.innerText || '').toLowerCase();
      if (bodyText.includes('virtual deal room') || bodyText.includes('rcm lightbox')) return true;
      // Download button present
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
      if (buttons.some(b => /download/i.test((b.innerText || b.textContent || '').trim()))) return true;
      // Grid/table with header checkbox + file columns
      const headerCb = document.querySelector('thead input[type="checkbox"], th input[type="checkbox"]');
      if (headerCb) return true;
      const hasNameHeader = !!Array.from(document.querySelectorAll('th, [role="columnheader"]')).find(th => /name/i.test((th as HTMLElement).innerText || ''));
      const hasLastMod = !!Array.from(document.querySelectorAll('th, [role="columnheader"]')).find(th => /last\s*modified/i.test((th as HTMLElement).innerText || ''));
      if (hasNameHeader && hasLastMod) return true;
      return false;
    }).catch(() => false);
    if (hit) return true;
  }
  return false;
}

async function ensureAgreementChecked(page: Page, options: AutofillOptions) {
  const patterns = /(i\s*agree|accept|terms|privacy|nda|confidential|confidentiality|non[-\s]?disclosure|consent)/i;
  // Obvious checkboxes by name/id
  await setCheckboxesBySelectors(page, [
    'input[type="checkbox"][name*="agree" i]',
    'input[type="checkbox"][id*="agree" i]',
    'input[type="checkbox"][name*="terms" i]',
    'input[type="checkbox"][id*="terms" i]',
    'input[type="checkbox"][name*="confidential" i]',
    'input[type="checkbox"][id*="confidential" i]'
  ]);

  // Heuristic via label text
  for (const frame of page.frames()) {
    await frame.evaluate((patStr: string) => {
      const pat = new RegExp(patStr, 'i');
      const boxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) as (HTMLInputElement | HTMLElement)[];
      for (const box of boxes) {
        let labelTxt = '';
        const input = box as HTMLInputElement;
        const id = input.id;
        const byFor = id ? document.querySelector(`label[for="${id}"]`) as HTMLLabelElement | null : null;
        if (byFor && byFor.innerText) labelTxt += ' ' + byFor.innerText;
        const closestLabel = box.closest('label') as HTMLLabelElement | null;
        if (closestLabel && closestLabel.innerText) labelTxt += ' ' + closestLabel.innerText;
        const aria = (box.getAttribute('aria-label') || '') + ' ' + (box.getAttribute('aria-labelledby') || '');
        labelTxt += ' ' + aria + ' ' + (box.parentElement?.textContent || '');

        if (pat.test(labelTxt)) {
          try {
            if ((box as HTMLInputElement).type === 'checkbox') {
              const cb = box as HTMLInputElement;
              if (!cb.checked) {
                cb.checked = true;
                cb.dispatchEvent(new Event('input', { bubbles: true }));
                cb.dispatchEvent(new Event('change', { bubbles: true }));
              }
            } else if (box.getAttribute('role') === 'checkbox') {
              if (box.getAttribute('aria-checked') !== 'true') {
                box.setAttribute('aria-checked', 'true');
                box.dispatchEvent(new Event('input', { bubbles: true }));
                box.dispatchEvent(new Event('change', { bubbles: true }));
                box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
              }
            }
          } catch {}
        }
      }
      // Radio groups that represent consent/agreements (choose Yes/Agree/Accept)
      const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
      const byName: Record<string, HTMLInputElement[]> = {};
      for (const r of radios) {
        const nm = r.name || r.getAttribute('name') || `__no_name__${Math.random()}`;
        (byName[nm] ||= []).push(r);
      }
      const positive = /(yes|agree|accept|i\s*agree|confirm)/i;
      for (const [nm, group] of Object.entries(byName)) {
        // If any label in group mentions consent, pick the positive option
        let groupMatches = false;
        const annotated: Array<{ el: HTMLInputElement; label: string }> = [];
        for (const r of group) {
          let lbl = '';
          const id = r.id;
          if (id) {
            const byFor = document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLLabelElement | null;
            if (byFor && byFor.innerText) lbl += ' ' + byFor.innerText;
          }
          const cl = r.closest('label') as HTMLLabelElement | null;
          if (cl && cl.innerText) lbl += ' ' + cl.innerText;
          const aria = (r.getAttribute('aria-label') || '') + ' ' + (r.getAttribute('aria-labelledby') || '');
          lbl += ' ' + aria + ' ' + (r.parentElement?.textContent || '');
          annotated.push({ el: r, label: lbl });
          if (pat.test(lbl)) groupMatches = true;
        }
        if (!groupMatches) continue;
        // Prefer a clearly positive option
        let pick = annotated.find(a => positive.test(a.label))?.el || annotated[0]?.el;
        if (pick && !pick.checked) {
          try {
            pick.checked = true;
            pick.dispatchEvent(new Event('input', { bubbles: true }));
            pick.dispatchEvent(new Event('change', { bubbles: true }));
            pick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          } catch {}
        }
      }
    }, patterns.source).catch(() => {});
  }

  // Optional: marketing/newsletter opt-in when aggressive/optInMarketing
  if (options.aggressive || options.optInMarketing) {
    await setCheckboxesByLabel(page, /(newsletter|marketing|promotions|updates|offers)/i);
  }
}

async function setCheckboxesBySelectors(page: Page, selectors: string[]) {
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

async function setCheckboxesByLabel(page: Page, pattern: RegExp) {
  const pat = pattern.source;
  for (const frame of page.frames()) {
    await frame.evaluate((patStr: string) => {
      const pat = new RegExp(patStr, 'i');
      const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
      for (const lb of labels) {
        const txt = (lb.innerText || lb.textContent || '').trim();
        if (txt && pat.test(txt)) {
          try {
            lb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            (lb as HTMLElement).click?.();
          } catch {}
        }
      }
    }, pat).catch(() => {});
  }
}

async function autofillVisibleForms(page: Page, options: AutofillOptions, DATA: Record<string, string | undefined>) {
  let totalChanged = 0;
  for (const frame of page.frames()) {
    const changed = await frame.evaluate(({ DATA, AUTOCOMPLETE_MAP, SYNONYMS, onlyRequired, skipSensitive, SENSITIVE }: any) => {
      const chooseValue = (key: keyof typeof DATA) => DATA[key] || '';
      const sensitive = (s: string) => SENSITIVE.test(s);
      let changed = 0;

      const inputs = Array.from(document.querySelectorAll('input, textarea, select')) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
      for (const el of inputs) {
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none' || (el as HTMLElement).offsetParent === null) continue;
        const type = (el as HTMLInputElement).type?.toLowerCase?.() || el.tagName.toLowerCase();
        if ([ 'button', 'submit', 'reset', 'file', 'image' ].includes(type)) continue;

        const id = el.getAttribute('id') || '';
        const nameAttr = el.getAttribute('name') || '';
        const aria = el.getAttribute('aria-label') || '';
        const placeholder = (el as any).placeholder || '';
        let labelTxt = '';
        if (id) {
          const byFor = document.querySelector(`label[for="${CSS.escape(id)}"]`) as HTMLLabelElement | null;
          if (byFor && byFor.innerText) labelTxt += ' ' + byFor.innerText;
        }
        const closestLabel = el.closest('label') as HTMLLabelElement | null;
        if (closestLabel && closestLabel.innerText) labelTxt += ' ' + closestLabel.innerText;
        const context = (el.parentElement?.textContent || '').slice(0, 200);

        const descriptor = `${nameAttr} ${id} ${aria} ${placeholder} ${labelTxt} ${context}`;

        if (skipSensitive && sensitive(descriptor)) continue;
        if (onlyRequired) {
          const req = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
          if (!req) continue;
        }

        // Autocomplete attribute mapping
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (ac && (ac in AUTOCOMPLETE_MAP)) {
          const v = chooseValue(AUTOCOMPLETE_MAP[ac]);
          if (v) { if (tryFill(el as any, v)) changed++; continue; }
        }

        // Type-based heuristics
        if (type === 'email') { const v = chooseValue('EMAIL'); if (v && tryFill(el as any, v)) { changed++; continue; } }
        if (type === 'tel') { const v = chooseValue('PHONE'); if (v && tryFill(el as any, v)) { changed++; continue; } }
        if (type === 'password') { const v = chooseValue('PASSWORD'); if (v && tryFill(el as any, v)) { changed++; continue; } }

        // Synonym-based
        for (const [key, regexes] of SYNONYMS as [string, RegExp[]][]) {
          const matched = regexes.some(r => r.test(descriptor));
          if (matched) {
            const v = chooseValue(key as any);
            if (v && tryFill(el as any, v)) changed++;
            break;
          }
        }
      }

      function tryFill(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string) {
        try {
          const tag = el.tagName.toLowerCase();
          if (tag === 'select') {
            const before = (el as HTMLSelectElement).value;
            if (before && before.trim() !== '') return false;
            (el as HTMLSelectElement).value = v;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            (el as any).blur?.();
            return true;
          }
          const current = (el as any).value ?? '';
          if (String(current).trim() !== '') return false;
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          if (desc && typeof desc.set === 'function') {
            desc.set.call(el, v);
          } else {
            (el as any).value = v;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          (el as any).blur?.();
          return true;
        } catch { return false; }
      }

      return changed;
    }, { DATA, AUTOCOMPLETE_MAP, SYNONYMS, onlyRequired: !!options.onlyRequired, skipSensitive: !!options.skipSensitive, SENSITIVE }).catch(() => 0);

    totalChanged += changed || 0;
  }
  return totalChanged;
}

async function tryAdvance(page: Page) {
  // Trigger blur and validation
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      const fields = Array.from(document.querySelectorAll('input, textarea, select')) as HTMLElement[];
      for (const el of fields) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      (document.activeElement as HTMLElement | null)?.blur?.();
    }).catch(() => {});
  }
  try { await page.mouse.click(2, 2); } catch {}

  // Common submit/continue triggers
  const advanced = await clickCommon(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Next")',
    'button:has-text("Continue")',
    'text=/Submit|Next|Continue|Proceed/i',
  ]);
  return advanced;
}

async function autofillFallbackSelectors(page: Page, DATA: Record<string, string | undefined>, options: AutofillOptions) {
  let changed = 0;
  const attempt = async (frame: Frame, selectors: string[], value?: string) => {
    if (!value) return false;
    for (const sel of selectors) {
      try {
        const loc = frame.locator(sel).first();
        if (await loc.count() === 0) continue;
        await loc.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
        try {
          await loc.fill(value, { timeout: 1500 });
        } catch {
          try {
            await loc.click({ timeout: 1000 });
            await loc.fill('');
            await loc.type(value, { delay: 10 });
          } catch {}
        }
        changed++;
        return true;
      } catch {}
    }
    return false;
  };

  const byKey = async (key: string, selectors: string[]) => {
    const v = DATA[key];
    if (!v) return;
    for (const f of page.frames()) {
      await attempt(f, selectors, v);
    }
  };

  await byKey('EMAIL', [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[id*="email" i]',
    'input[aria-label*="email" i]',
    'input[placeholder*="email" i]'
  ]);
  await byKey('FIRST_NAME', [
    'input[name*="first" i]',
    'input[id*="first" i]',
    'input[placeholder*="first" i]'
  ]);
  await byKey('LAST_NAME', [
    'input[name*="last" i]',
    'input[id*="last" i]',
    'input[placeholder*="last" i]'
  ]);
  await byKey('FULL_NAME', [
    'input[name*="name" i]:not([name*="first" i]):not([name*="last" i])',
    'input[placeholder*="name" i]:not([placeholder*="first" i]):not([placeholder*="last" i])'
  ]);
  await byKey('COMPANY', [
    'input[name*="company" i], input[name*="organization" i]',
    'input[placeholder*="company" i], input[placeholder*="organization" i]',
    'input[id*="company" i], input[id*="organization" i]'
  ]);
  // Phone fields often require masked typing; try multiple variants
  const pv = phoneVariants(DATA['PHONE']);
  if (pv.length) {
    for (const f of page.frames()) {
      let done = false;
      for (const variant of pv) {
        done = await attempt(f, [
          'input[type="tel"]',
          'input[name*="phone" i]',
          'input[id*="phone" i]',
          'input[aria-label*="phone" i]',
          'input[placeholder*="phone" i]',
          'input[name*="tel" i]',
          'input[id*="tel" i]',
          'input[aria-label*="tel" i]',
          'input[placeholder*="tel" i]',
          'input[name*="contact" i]',
          'input[id*="contact" i]'
        ], variant);
        if (done) break;
      }
      if (done) break;
      // Try by associated label 'for' id
      try {
        const selectors = await f.evaluate((patStr: string) => {
          const pat = new RegExp(patStr, 'i');
          const sels: string[] = [];
          const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[];
          for (const lb of labels) {
            const txt = (lb.innerText || lb.textContent || '').trim();
            if (!txt || !pat.test(txt)) continue;
            const forId = lb.getAttribute('for');
            if (forId) sels.push(`#${CSS.escape(forId)}`);
          }
          return sels.slice(0, 3);
        }, '(phone|mobile|cell|tel|telephone|contact)').catch(() => [] as string[]);
        for (const sel of selectors || []) {
          let ok = false;
          for (const variant of pv) {
            ok = await attempt(f, [sel], variant);
            if (ok) break;
          }
          if (ok) break;
        }
      } catch {}
    }
  }
  await byKey('TITLE', [
    'input[name*="title" i]',
    'input[placeholder*="title" i]'
  ]);

  return changed;
}

function phoneVariants(raw?: string): string[] {
  const v = (raw || '').trim();
  if (!v) return [];
  const digits = v.replace(/\D+/g, '');
  const last10 = digits.slice(-10);
  const prettyDash = last10 ? `${last10.slice(0,3)}-${last10.slice(3,6)}-${last10.slice(6)}` : digits;
  const prettyParen = last10 ? `(${last10.slice(0,3)}) ${last10.slice(3,6)}-${last10.slice(6)}` : digits;
  const e164 = last10 ? `+1${last10}` : (digits.startsWith('+') ? digits : `+${digits}`);
  const uniq = Array.from(new Set([v, digits, last10, prettyDash, prettyParen, e164].filter(Boolean)));
  return uniq as string[];
}
