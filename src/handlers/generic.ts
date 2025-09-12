import type { Page } from 'playwright';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';
import { fillFieldSmart, type FallbackRunContext } from './smartStep.js';
import { stagehandFallback, hostFromUrl } from '../config/stagehandFallback.js';
import type { DealIngestionJob } from '../types.js';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function handleGeneric(page: Page, ctx: { job: DealIngestionJob; workingDir: string; urls: string[] }) {
  console.log('Generic Handler: Processing URLs:', ctx.urls);
  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  const url = ctx.urls[0];
  console.log('Generic Handler: Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(()=>{});
  console.log('Generic Handler: Page loaded, current URL:', page.url());

  // Take screenshot before any interaction
  await page.screenshot({ path: 'runs/generic-before-interaction.png' }).catch(()=>{});

  // Stagehand fallback context (gated by per-host config inside helpers)
  const host = hostFromUrl(page.url());
  const cfg = stagehandFallback[host];
  const shCtx: FallbackRunContext = {
    stepsUsed: 0,
    maxSteps: cfg?.maxFallbackStepsPerRun ?? 3,
    artifactsDir: path.join(ctx.workingDir, 'stagehand')
  };

  // Handle user info form if present
  await handleUserInfoForm(page, shCtx);

  // Handle checkboxes and agreements
  console.log('Generic Handler: Looking for checkboxes and agreements...');
  await handleAllCheckboxes(page);

  // Look for common agreement buttons
  await clickIfExists(page, 'button:has-text("I Agree"), button:has-text("Accept")');
  await clickIfExists(page, 'button:has-text("Continue"), button:has-text("Proceed")');
  await page.waitForTimeout(2000); // Wait for navigation

  // Take screenshot after agreements
  await page.screenshot({ path: 'runs/generic-after-agreements.png' }).catch(()=>{});

  // Navigate to Documents section if available
  console.log('Generic Handler: Looking for Documents section...');
  await clickIfExists(page, 'a:has-text("Documents"), [role="tab"]:has-text("Documents")');
  await page.waitForLoadState('networkidle').catch(()=>{});

  // Take screenshot after navigation
  await page.screenshot({ path: 'runs/generic-documents.png' }).catch(()=>{});

  const archive = await clickDownloadAll(page, [
    'button:has-text("Download All")',
    'a:has-text("Download All")',
    'button[title*="Download All"]'
  ], outDir).catch(() => null);

  if (archive) return outDir;

  console.log('Generic Handler: Attempting to enumerate file links...');
  await enumerateFileLinks(page, [
    'a[href*="download"]',
    'a:has-text("Download")',
    'a[href$=".pdf"], a[href$=".zip"], a[href$=".xlsx"], a[href$=".docx"]'
  ], outDir).catch(e => {
    console.log('Generic Handler: Failed to enumerate files, error:', e.message);
    throw e;
  });

  // Write minimal Stagehand stats for audit consumption
  try {
    const statsPath = path.join(ctx.workingDir, 'stagehand-stats.json');
    await fs.writeFile(statsPath, JSON.stringify({
      host,
      enabled: Boolean(cfg?.enabled),
      steps_used: shCtx.stepsUsed,
      max_steps: shCtx.maxSteps,
      artifactsDir: shCtx.artifactsDir
    }, null, 2), 'utf8');
  } catch {}

  return outDir;
}

async function handleUserInfoForm(page: Page, shCtx?: FallbackRunContext) {
  console.log('Generic Handler: Checking for user info form...');
  
  const formFields = [
    { 
      selectors: [
        'input[name*="first" i], input[name*="fname" i], input[name*="firstName" i]',
        'input[placeholder*="first" i], input[placeholder*="fname" i]',
        'input[id*="first" i], input[id*="fname" i]'
      ], 
      value: process.env.USER_FIRST_NAME || 'William' 
    },
    { 
      selectors: [
        'input[name*="last" i], input[name*="lname" i], input[name*="lastName" i]',
        'input[placeholder*="last" i], input[placeholder*="surname" i]',
        'input[id*="last" i], input[id*="lname" i]'
      ], 
      value: process.env.USER_LAST_NAME || 'Cromartie' 
    },
    { 
      selectors: [
        'input[name*="email" i], input[type="email"]',
        'input[placeholder*="email" i]',
        'input[id*="email" i]'
      ], 
      value: process.env.USER_EMAIL || 'wcromartie@Orhlp.com' 
    },
    { 
      selectors: [
        'input[name*="company" i], input[name*="organization" i]',
        'input[placeholder*="company" i], input[placeholder*="organization" i]',
        'input[id*="company" i], input[id*="organization" i]'
      ], 
      value: process.env.COMPANY_NAME || 'Odyssey Residential Holdings' 
    },
    { 
      selectors: [
        'input[name*="phone" i], input[type="tel"]',
        'input[placeholder*="phone" i], input[placeholder*="mobile" i]',
        'input[id*="phone" i], input[id*="mobile" i]'
      ], 
      value: process.env.USER_PHONE || '972-478-0485' 
    }
  ];
  
  let filledAnyField = false;
  
  for (const field of formFields) {
    for (const selector of field.selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const currentValue = await element.inputValue();
          if (!currentValue) {
            console.log(`Generic Handler: Filling ${selector} with "${field.value}"`);
            await element.fill(field.value);
            filledAnyField = true;
            await page.waitForTimeout(500);
            break;
          }
        }
      } catch (error) {
        console.log(`Generic Handler: Error filling field ${selector}:`, error.message);
      }
    }
  }
  
  if (filledAnyField) {
    console.log('Generic Handler: Form filled, checking for required checkboxes...');
    await handleFormCheckboxes(page);
  } else {
    // Deterministic did not confidently fill anything; try targeted Stagehand fallbacks for common fields
    try {
      const candidates: Array<[string, string]> = [
        ['Email', process.env.USER_EMAIL || 'test@example.com'],
        ['First Name', process.env.USER_FIRST_NAME || 'Test'],
        ['Last Name', process.env.USER_LAST_NAME || 'User'],
        ['Company', process.env.COMPANY_NAME || process.env.USER_COMPANY || 'Example Company LLC'],
        ['Phone', process.env.USER_PHONE || '(555) 123-4567']
      ];
      for (const [label, value] of candidates) {
        try {
          const res = await fillFieldSmart(page, label, value, shCtx ? { ctx: shCtx } : undefined);
          if (res?.method === 'deterministic' || res?.method === 'stagehand') {
            filledAnyField = true;
          }
        } catch {}
      }
      if (filledAnyField) {
        console.log('Generic Handler: Stagehand fallback filled at least one field, checking form checkboxes...');
        await handleFormCheckboxes(page);
      }
    } catch {}
  }
}

async function handleFormCheckboxes(page: Page) {
  const checkboxes = await page.$$('input[type="checkbox"]');
  
  for (const checkbox of checkboxes) {
    try {
      const labelText = await page.evaluate((cb) => {
        const id = cb.id;
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) return label.textContent || '';
        }
        const parent = cb.closest('label') || cb.parentElement;
        return parent ? parent.textContent || '' : '';
      }, checkbox);
      
      console.log(`Generic Handler: Found form checkbox: "${labelText}"`);
      
      const shouldCheck = labelText.toLowerCase().includes('agree') ||
                         labelText.toLowerCase().includes('accept') ||
                         labelText.toLowerCase().includes('privacy') ||
                         labelText.toLowerCase().includes('terms') ||
                         labelText.toLowerCase().includes('consent');
      
      if (shouldCheck) {
        const isChecked = await checkbox.isChecked();
        if (!isChecked) {
          console.log('Generic Handler: Checking required checkbox');
          await page.evaluate((el: any) => (el as HTMLElement).click(), checkbox);
          await page.waitForTimeout(500);
        }
      }
    } catch (error) {
      console.log('Generic Handler: Error handling form checkbox:', error);
    }
  }
}

async function handleAllCheckboxes(page: Page) {
  console.log('Generic Handler: Looking for all checkboxes to check...');
  
  const checkboxes = await page.$$('input[type="checkbox"]');
  console.log(`Generic Handler: Found ${checkboxes.length} checkboxes total`);
  
  for (let i = 0; i < checkboxes.length; i++) {
    try {
      const checkbox = checkboxes[i];
      
      const isVisible = await checkbox.isVisible().catch(() => false);
      if (!isVisible) {
        console.log(`Generic Handler: Checkbox ${i + 1} is not visible, skipping`);
        continue;
      }
      
      const labelText = await page.evaluate((cb) => {
        const id = cb.id;
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) return label.textContent || '';
        }
        const parent = cb.closest('label') || cb.parentElement;
        return parent ? parent.textContent || '' : '';
      }, checkbox).catch(() => 'Unknown');
      
      console.log(`Generic Handler: Checkbox ${i + 1} text: "${labelText}"`);
      
      // Skip 1031 exchange checkboxes
      if (labelText.toLowerCase().includes('1031')) {
        console.log('Generic Handler: Skipping 1031 exchange checkbox');
        continue;
      }
      
      const isChecked = await checkbox.isChecked().catch(() => true);
      
      if (!isChecked) {
        console.log(`Generic Handler: Checking checkbox ${i + 1}: "${labelText}"`);
        
        try {
          await page.evaluate((el: any) => (el as HTMLElement).click(), checkbox);
          console.log(`Generic Handler: Successfully clicked checkbox ${i + 1}`);
        } catch (error) {
          console.log(`Generic Handler: Checkbox click failed, trying label for checkbox ${i + 1}`);
          
          try {
            const checkboxId = await checkbox.getAttribute('id');
            if (checkboxId) {
              const label = await page.$(`label[for="${checkboxId}"]`);
              if (label) {
                await page.evaluate((el: any) => (el as HTMLElement).click(), label);
                console.log(`Generic Handler: Successfully clicked label for checkbox ${i + 1}`);
              }
            }
          } catch (labelError) {
            console.log(`Generic Handler: Could not click checkbox ${i + 1}:`, labelError.message);
          }
        }
        
        await page.waitForTimeout(500);
      } else {
        console.log(`Generic Handler: Checkbox ${i + 1} already checked`);
      }
    } catch (error) {
      console.log(`Generic Handler: Error handling checkbox ${i + 1}:`, error.message);
    }
  }
}

async function clickIfExists(page: Page, selector: string) {
  try {
    const element = await page.$(selector);
    if (element) {
      const isVisible = await element.isVisible().catch(() => false);
      if (isVisible) {
        console.log(`Generic Handler: Found and clicking: ${selector}`);
        
        try {
          await page.evaluate((el: any) => (el as HTMLElement).click(), element);
          console.log(`Generic Handler: Successfully clicked: ${selector}`);
        } catch (jsError) {
          console.log(`Generic Handler: JS click failed, trying direct click: ${selector}`);
          await element.click();
        }
        
        await page.waitForTimeout(1000);
      } else {
        console.log(`Generic Handler: Element not visible: ${selector}`);
      }
    } else {
      console.log(`Generic Handler: Element not found: ${selector}`);
    }
  } catch (error) {
    console.log(`Generic Handler: Error clicking ${selector}:`, error.message);
  }
}

