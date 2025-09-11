import type { Page } from 'playwright';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';
import type { DealIngestionJob } from '../types.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function handleBuildout(page: Page, ctx: { job: DealIngestionJob; workingDir: string; urls: string[] }) {
  console.log('Buildout Handler: Processing URLs:', ctx.urls);
  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  // 1) Navigate to NDA / agreement if present
  const target = ctx.urls.find(u => /buildout\.com/i.test(u)) ?? ctx.urls[0];
  console.log('Buildout Handler: Navigating to:', target);
  await page.goto(target, { waitUntil: 'domcontentloaded' });

  // Wait for page to settle
  await page.waitForLoadState('networkidle').catch(()=>{});
  console.log('Buildout Handler: Page loaded, current URL:', page.url());

  // Take screenshot before any interaction
  await page.screenshot({ path: 'runs/buildout-before-interaction.png' }).catch(()=>{});

  // 2) Handle user info form if present
  await handleUserInfoForm(page);

  // 3) Handle checkboxes and NDA flows
  console.log('Buildout Handler: Looking for checkboxes and agreements...');
  await handleAllCheckboxes(page);
  
  // 4) NDA flows: look for common patterns with enhanced clicking
  await clickIfExists(page, 'button:has-text("I Agree"), button:has-text("Accept")');
  await clickIfExists(page, 'button:has-text("Continue"), button:has-text("Proceed")');
  await clickIfExists(page, 'text=Confidentiality');
  await page.waitForTimeout(2000); // Wait for navigation

  // Take screenshot after NDA
  await page.screenshot({ path: 'runs/buildout-after-nda.png' }).catch(()=>{});

  // 5) Navigate to Documents section if needed
  console.log('Buildout Handler: Looking for Documents section...');
  await clickIfExists(page, 'a:has-text("Documents"), [role="tab"]:has-text("Documents")');
  await page.waitForLoadState('networkidle').catch(()=>{});

  // Take screenshot after navigation
  await page.screenshot({ path: 'runs/buildout-documents.png' }).catch(()=>{});

  // 6) Prefer a "Download All" if present
  const archive = await clickDownloadAll(page, [
    'button:has-text("Download All")',
    'a:has-text("Download All")',
    'button[aria-label="Download All"]',
    'button[title*="Download All"]'
  ], outDir).catch(() => null);

  if (archive) return outDir;

  // 7) Fallback: enumerate file links in a documents grid/list
  console.log('Buildout Handler: Attempting to enumerate file links...');
  await enumerateFileLinks(page, [
    'a[href*="download"]',
    'a:has-text("Download")',
    'a[href$=".pdf"], a[href$=".zip"], a[href$=".xlsx"], a[href$=".docx"]'
  ], outDir).catch(e => {
    console.log('Buildout Handler: Failed to enumerate files, error:', e.message);
    throw e;
  });

  return outDir;
}

async function handleUserInfoForm(page: Page) {
  console.log('Buildout Handler: Checking for user info form...');
  
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
            console.log(`Buildout Handler: Filling ${selector} with "${field.value}"`);
            await element.fill(field.value);
            filledAnyField = true;
            await page.waitForTimeout(500);
            break;
          }
        }
      } catch (error) {
        console.log(`Buildout Handler: Error filling field ${selector}:`, error.message);
      }
    }
  }
  
  if (filledAnyField) {
    console.log('Buildout Handler: Form filled, checking for required checkboxes...');
    await handleFormCheckboxes(page);
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
      
      console.log(`Buildout Handler: Found form checkbox: "${labelText}"`);
      
      const shouldCheck = labelText.toLowerCase().includes('agree') ||
                         labelText.toLowerCase().includes('accept') ||
                         labelText.toLowerCase().includes('privacy') ||
                         labelText.toLowerCase().includes('terms') ||
                         labelText.toLowerCase().includes('consent');
      
      if (shouldCheck) {
        const isChecked = await checkbox.isChecked();
        if (!isChecked) {
          console.log('Buildout Handler: Checking required checkbox');
          await page.evaluate((el: any) => (el as HTMLElement).click(), checkbox);
          await page.waitForTimeout(500);
        }
      }
    } catch (error) {
      console.log('Buildout Handler: Error handling form checkbox:', error);
    }
  }
}

async function handleAllCheckboxes(page: Page) {
  console.log('Buildout Handler: Looking for all checkboxes to check...');
  
  const checkboxes = await page.$$('input[type="checkbox"]');
  console.log(`Buildout Handler: Found ${checkboxes.length} checkboxes total`);
  
  for (let i = 0; i < checkboxes.length; i++) {
    try {
      const checkbox = checkboxes[i];
      
      const isVisible = await checkbox.isVisible().catch(() => false);
      if (!isVisible) {
        console.log(`Buildout Handler: Checkbox ${i + 1} is not visible, skipping`);
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
      
      console.log(`Buildout Handler: Checkbox ${i + 1} text: "${labelText}"`);
      
      // Skip 1031 exchange checkboxes
      if (labelText.toLowerCase().includes('1031')) {
        console.log('Buildout Handler: Skipping 1031 exchange checkbox');
        continue;
      }
      
      const isChecked = await checkbox.isChecked().catch(() => true);
      
      if (!isChecked) {
        console.log(`Buildout Handler: Checking checkbox ${i + 1}: "${labelText}"`);
        
          try {
            await page.evaluate((el: any) => (el as HTMLElement).click(), checkbox);
          console.log(`Buildout Handler: Successfully clicked checkbox ${i + 1}`);
        } catch (error) {
          console.log(`Buildout Handler: Checkbox click failed, trying label for checkbox ${i + 1}`);
          
          try {
            const checkboxId = await checkbox.getAttribute('id');
            if (checkboxId) {
              const label = await page.$(`label[for="${checkboxId}"]`);
              if (label) {
          await page.evaluate((el: any) => (el as HTMLElement).click(), label);
                console.log(`Buildout Handler: Successfully clicked label for checkbox ${i + 1}`);
              }
            }
          } catch (labelError) {
            console.log(`Buildout Handler: Could not click checkbox ${i + 1}:`, labelError.message);
          }
        }
        
        await page.waitForTimeout(500);
      } else {
        console.log(`Buildout Handler: Checkbox ${i + 1} already checked`);
      }
    } catch (error) {
      console.log(`Buildout Handler: Error handling checkbox ${i + 1}:`, error.message);
    }
  }
}

async function clickIfExists(page: Page, selector: string) {
  try {
    const element = await page.$(selector);
    if (element) {
      const isVisible = await element.isVisible().catch(() => false);
      if (isVisible) {
        console.log(`Buildout Handler: Found and clicking: ${selector}`);
        
        try {
          await page.evaluate((el: any) => (el as HTMLElement).click(), element);
          console.log(`Buildout Handler: Successfully clicked: ${selector}`);
        } catch (jsError) {
          console.log(`Buildout Handler: JS click failed, trying direct click: ${selector}`);
          await element.click();
        }
        
        await page.waitForTimeout(1000);
      } else {
        console.log(`Buildout Handler: Element not visible: ${selector}`);
      }
    } else {
      console.log(`Buildout Handler: Element not found: ${selector}`);
    }
  } catch (error) {
    console.log(`Buildout Handler: Error clicking ${selector}:`, error.message);
  }
}

