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
    page.waitForEvent('download', { timeout: 45_000 }).catch(() => null),
    clickElement(page, sel)
  ]);

  // Handle download confirmation dialogs
  if (!download) {
    console.log('Download: No download started, checking for confirmation dialogs...');
    await handleDownloadConfirmation(page);
    
    // Try waiting for download again after handling confirmation
    const [ secondDownload ] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
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
        page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
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
    'button:has-text("Continue")',
    'button:has-text("Download")',
    'button:has-text("Proceed")',
    'button:has-text("Yes")',
    '[role="button"]:has-text("Okay")',
    '[role="button"]:has-text("OK")',
    '.modal button:has-text("Okay")',
    '.dialog button:has-text("OK")'
  ];
  
  for (const selector of confirmationSelectors) {
    try {
      const element = await page.$(selector);
      if (element) {
        const isVisible = await element.isVisible().catch(() => false);
        if (isVisible) {
          console.log('Download: Found confirmation dialog, clicking:', selector);
          await page.evaluate((el) => (el as HTMLElement).click(), element);
          await page.waitForTimeout(1000);
          return;
        }
      }
    } catch (error) {
      console.log('Download: Error checking confirmation selector:', selector, (error as Error).message);
    }
  }
  
  console.log('Download: No confirmation dialog found');
}

function sanitize(s?: string) {
  const cleaned = (s || 'file').replace(/[^a-z0-9-_.]+/gi, '_');
  console.log('Download: Sanitized filename:', s, '->', cleaned);
  return cleaned;
}