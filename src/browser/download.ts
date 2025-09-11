import { Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function clickDownloadAll(page: Page, buttonSelectorCandidates: string[], outDir: string) {
  await fs.mkdir(outDir, { recursive: true });

  // Find a working selector with enhanced selection
  const sel = await resolveSelector(page, buttonSelectorCandidates);
  if (!sel) {
    console.log('Download: No Download All button found from candidates:', buttonSelectorCandidates);
    throw new Error('No Download All button found');
  }

  console.log('Download: Found Download All button:', sel);
  
  // Enhanced clicking with JavaScript fallback
  const [ download ] = await Promise.all([
    page.context().waitForEvent('download', { timeout: 45_000 }).catch(() => null),
    clickElement(page, sel)
  ]);

  // Handle download confirmation dialogs
  if (!download) {
    console.log('Download: No download started, checking for confirmation dialogs...');
    await handleDownloadConfirmation(page);
    
    // Try waiting for download again after handling confirmation
    const [ secondDownload ] = await Promise.all([
      page.context().waitForEvent('download', { timeout: 30_000 }).catch(() => null),
      Promise.resolve() // Already clicked, just wait
    ]);
    
    if (secondDownload) {
      const suggested = sanitize(await secondDownload.suggestedFilename());
      const to = path.join(outDir, suggested || `bundle.zip`);
      await secondDownload.saveAs(to);
      console.log('Download: Successfully downloaded after confirmation:', to);
      return to;
    }
  }

  if (download) {
    const suggested = sanitize(await download.suggestedFilename());
    const to = path.join(outDir, suggested || `bundle.zip`);
    await download.saveAs(to);
    console.log('Download: Successfully downloaded:', to);
    return to;
  }

  console.log('Download: No download occurred, likely need to enumerate individual files');
  return null;
}

export async function enumerateFileLinks(page: Page, linkSelectorCandidates: string[], outDir: string) {
  await fs.mkdir(outDir, { recursive: true });
  const selector = await resolveSelector(page, linkSelectorCandidates);
  if (!selector) {
    console.log('Download: No file links found from candidates:', linkSelectorCandidates);
    throw new Error('No file links found');
  }

  console.log('Download: Found file links using selector:', selector);
  const hrefs = await page.$$eval(selector, as => as.map(a => (a as any).href).filter(Boolean));
  const unique = Array.from(new Set(hrefs));
  console.log('Download: Found', unique.length, 'unique file links');

  // Enhanced individual file download with better error handling
  const saved: string[] = [];
  for (let i = 0; i < unique.length; i++) {
    const href = unique[i];
    console.log(`Download: Attempting to download file ${i + 1}/${unique.length}:`, href);
    
    try {
      const [ download ] = await Promise.all([
        page.context().waitForEvent('download', { timeout: 30_000 }).catch(() => null),
        page.evaluate((u) => ((globalThis as any).window as any).location.href = u, href)
      ]);
      
      // Handle download confirmation if needed
      if (!download) {
        console.log('Download: No download started for file, checking for confirmation...');
        await handleDownloadConfirmation(page);
        await page.waitForTimeout(2000); // Give time for download to start
      }
      
      if (download) {
        const suggested = sanitize(await download.suggestedFilename());
        const to = path.join(outDir, suggested || `file_${i + 1}`);
        await download.saveAs(to);
        saved.push(to);
        console.log(`Download: Successfully saved file ${i + 1}:`, suggested);
      } else {
        console.log(`Download: Failed to download file ${i + 1}:`, href);
      }
      
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(()=>{});
      await page.waitForTimeout(1000); // Delay between downloads
    } catch (error) {
      console.log(`Download: Error downloading file ${i + 1}:`, (error as Error).message);
    }
  }
  
  console.log('Download: Successfully downloaded', saved.length, 'files');
  return saved;
}

async function resolveSelector(page: Page, candidates: string[]) {
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el) {
        const isVisible = await el.isVisible().catch(() => false);
        if (isVisible) {
          console.log('Download: Found visible element for selector:', sel);
          return sel;
        } else {
          console.log('Download: Found element but not visible:', sel);
        }
      }
    } catch (error) {
      console.log('Download: Error checking selector:', sel, (error as Error).message);
    }
  }
  return null;
}

async function clickElement(page: Page, selector: string) {
  try {
    const element = await page.$(selector);
    if (element) {
      console.log('Download: Attempting JavaScript click on:', selector);
      try {
        await page.evaluate((el) => (el as HTMLElement).click(), element);
        console.log('Download: JavaScript click successful');
      } catch (jsError) {
        console.log('Download: JavaScript click failed, trying direct click:', (jsError as Error).message);
        await page.click(selector);
      }
    }
  } catch (error) {
    console.log('Download: Error clicking element:', selector, (error as Error).message);
    throw error;
  }
}

async function handleDownloadConfirmation(page: Page) {
  console.log('Download: Checking for download confirmation dialogs...');
  
  const confirmationSelectors = [
    'button:has-text("Okay")',
    'button:has-text("OK")', 
    'button:has-text("Ok")',
    'button:has-text("Continue")',
    'button:has-text("Download")',
    'button:has-text("Proceed")',
    'button:has-text("Create Zip")',
    'button:has-text("Generate")',
    'button:has-text("Prepare")',
    'button:has-text("Yes")',
    '[role="button"]:has-text("Okay")',
    '[role="button"]:has-text("OK")',
    '[role="button"]:has-text("Ok")',
    '.modal button:has-text("Okay")',
    '.dialog button:has-text("OK")'
  ];
  
  // Check both main frame and iframes
  for (const selector of confirmationSelectors) {
    try {
      // main frame first
      const element = await page.$(selector);
      if (element && await element.isVisible().catch(() => false)) {
        console.log('Download: Found confirmation dialog, clicking:', selector);
        await page.evaluate((el) => (el as HTMLElement).click(), element);
        await page.waitForTimeout(1000);
        return;
      }
      // then iframes
      for (const frame of page.frames()) {
        try {
          const fe = await frame.$(selector);
          if (fe && await fe.isVisible().catch(() => false)) {
            console.log('Download: Found confirmation dialog in frame, clicking:', selector);
            await frame.evaluate((el) => (el as HTMLElement).click(), fe);
            await page.waitForTimeout(1000);
            return;
          }
        } catch {}
      }
    } catch (error) {
      console.log('Download: Error checking confirmation selector:', selector, (error as Error).message);
    }
  }
  
  console.log('Download: No confirmation dialog found');

  // Try within any visible dialog container generically
  try {
    const dialogs = page.locator('[role="dialog"], .modal-dialog, .k-dialog, .k-window');
    const count = await dialogs.count();
    for (let i = 0; i < count; i++) {
      const d = dialogs.nth(i);
      if (!(await d.isVisible().catch(() => false))) continue;
      const act = d.locator('button:has-text(/^(Okay|OK|Ok|Yes|Confirm|Proceed|Start|Download|Create|Generate|Prepare)/i)');
      if (await act.count()) {
        console.log('Download: Clicking action button inside dialog');
        await act.first().click({ timeout: 2000 }).catch(async () => {
          try { await act.first().dispatchEvent('click'); } catch {}
        });
        await page.waitForTimeout(1000);
        return;
      }
    }
  } catch {}
}

function sanitize(s?: string) {
  const cleaned = (s || 'file').replace(/[^a-z0-9-_.]+/gi, '_');
  console.log('Download: Sanitized filename:', s, '->', cleaned);
  return cleaned;
}
