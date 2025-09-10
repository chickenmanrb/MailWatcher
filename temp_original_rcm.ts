import type { Page } from 'playwright';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';
import type { DealIngestionJob } from '../types.js';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function handleRcm(page: Page, ctx: { job: DealIngestionJob; workingDir: string; urls: string[] }) {
  console.log('RCM Handler: Processing URLs:', ctx.urls);
  const outDir = path.join(ctx.workingDir, 'downloads');
  await fs.mkdir(outDir, { recursive: true });

  const url = ctx.urls.find(u => /rcm|intralinks|dealsecure|datasite/i.test(u)) ?? ctx.urls[0];
  console.log('RCM Handler: Navigating to:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Many RCMs use SSO/redirect—let the session settle
  await page.waitForLoadState('networkidle').catch(()=>{});
  console.log('RCM Handler: Page loaded, current URL:', page.url());

  // Take screenshot before any interaction
  await page.screenshot({ path: 'runs/rcm-before-interaction.png' }).catch(()=>{});
  
  // STEP 1: Check for Sal Jafar user selection FIRST
  const hadSalJafar = await handleSalJafarSelection(page);
  
  // If we had Sal Jafar selection, wait for navigation and take new screenshot
  if (hadSalJafar) {
    await page.waitForLoadState('networkidle').catch(()=>{});
    await page.screenshot({ path: 'runs/rcm-after-sal-jafar.png' }).catch(()=>{});
    console.log('RCM Handler: After Sal Jafar selection, current URL:', page.url());
  }
  
  // STEP 2: Handle user info form if present
  await handleUserInfoForm(page);
  
  // STEP 3: Handle checkboxes (avoiding 1031 exchange)
  console.log('RCM Handler: Looking for checkboxes to check...');
  await handleAllCheckboxes(page);
  
  // STEP 4: Click I Agree button
  console.log('RCM Handler: Looking for I Agree button...');
  await clickIfExists(page, 'button:has-text("I Agree"), button:has-text("Accept")');
  await clickIfExists(page, 'button:has-text("Continue"), button:has-text("Proceed")');
  await page.waitForTimeout(2000); // Wait for navigation

  // Take screenshot after NDA
  await page.screenshot({ path: 'runs/rcm-after-nda.png' }).catch(()=>{});
  
  // Navigate to Documents
  console.log('RCM Handler: Looking for Documents section...');
  await clickIfExists(page, 'a:has-text("Documents"), [role="tab"]:has-text("Documents")');
  await page.waitForLoadState('networkidle').catch(()=>{});
  
  // Take screenshot after navigation
  await page.screenshot({ path: 'runs/rcm-documents.png' }).catch(()=>{});

  const archive = await clickDownloadAll(page, [
    'button:has-text("Download All")',
    'button[title*="Download All"]'
  ], outDir).catch(() => null);

  if (archive) return outDir;

  console.log('RCM Handler: Attempting to enumerate file links...');
  await enumerateFileLinks(page, [
    'a[href*="download"]',
    'a:has-text("Download")',
    'a[href$=".pdf"]',
    'a[href$=".zip"]',
    'a[href$=".xlsx"]',
    'a[href$=".docx"]'
  ], outDir).catch(e => {
    console.log('RCM Handler: Failed to enumerate files, error:', e.message);
    throw e;
  });
  return outDir;
}

async function handleSalJafarSelection(page: Page): Promise<boolean> {
  console.log('RCM Handler: Checking for Sal Jafar selection...');
  
  // Check if page contains "sal jafar" text
  const pageText = await page.textContent('body').catch(() => '');
  
  if (pageText && pageText.toLowerCase().includes('sal jafar')) {
    console.log('RCM Handler: Found Sal Jafar selection page');
    
    // Look for "not sal jafar?" option - try clickable elements first
    const clickableSelectors = [
      'button:has-text("Not Sal Jafar?")',
      'button:has-text("No, I am not Sal Jafar")',
      'a:has-text("Not Sal Jafar?")',
      'a:has-text("No")',
      '[role="button"]:has-text("Not Sal Jafar")'
    ];
    
    // Take a screenshot to see the page
    await page.screenshot({ path: 'runs/rcm-sal-jafar-page.png' }).catch(()=>{});
    
    // Simple direct click on "Not Sal Jafar" text
    try {
      console.log('RCM Handler: Attempting simple click on "Not Sal Jafar"');
      await page.locator('text=Not Sal Jafar').first().click({ timeout: 10000 });
      console.log('RCM Handler: Successfully clicked "Not Sal Jafar"');
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle').catch(() => {});
      return true;
    } catch (error) {
      console.log('RCM Handler: Simple click failed:', error.message);
    }
    
    // If all direct clicks fail, try finding and clicking radio buttons
    console.log('RCM Handler: Trying radio buttons...');
    const radioButtons = await page.$$('input[type="radio"]');
    for (let i = 0; i < radioButtons.length; i++) {
      try {
        const radio = radioButtons[i];
        const labelText = await page.evaluate((r) => {
          const id = r.id;
          if (id) {
            const label = document.querySelector(`label[for="${id}"]`);
            if (label) return label.textContent || '';
          }
          const parent = r.closest('label') || r.parentElement;
          return parent ? parent.textContent || '' : '';
        }, radio);
        
        console.log(`RCM Handler: Radio button ${i + 1} text: "${labelText}"`);
        
        if (labelText.toLowerCase().includes('not') && labelText.toLowerCase().includes('sal')) {
          console.log(`RCM Handler: Clicking radio button ${i + 1} for "Not Sal Jafar"`);
          await radio.click();
          await page.waitForTimeout(3000);
          return true;
        }
      } catch (error) {
        console.log(`RCM Handler: Error with radio button ${i + 1}:`, error.message);
      }
    }
    
    console.log('RCM Handler: Could not find clickable "Not Sal Jafar" option');
    return true; // Still return true since we found the Sal Jafar page
  }
  
  console.log('RCM Handler: No Sal Jafar selection found');
  return false;
}

async function handleUserInfoForm(page: Page) {
  console.log('RCM Handler: Checking for user info form...');
  
  // Look for common form fields with case-insensitive matching
  const formFields = [
    // First name variations
    { 
      selectors: [
        'input[name*="first" i], input[name*="fname" i], input[name*="firstName" i]',
        'input[placeholder*="first" i], input[placeholder*="fname" i]',
        'input[id*="first" i], input[id*="fname" i]'
      ], 
      value: process.env.USER_FIRST_NAME || 'William' 
    },
    // Last name variations
    { 
      selectors: [
        'input[name*="last" i], input[name*="lname" i], input[name*="lastName" i], input[name*="surname" i]',
        'input[placeholder*="last" i], input[placeholder*="surname" i]',
        'input[id*="last" i], input[id*="lname" i]'
      ], 
      value: process.env.USER_LAST_NAME || 'Cromartie' 
    },
    // Full name (fallback)
    { 
      selectors: [
        'input[name*="name" i]:not([name*="first" i]):not([name*="last" i]):not([name*="company" i])',
        'input[placeholder*="name" i]:not([placeholder*="first" i]):not([placeholder*="last" i]):not([placeholder*="company" i])',
        'input[id*="name" i]:not([id*="first" i]):not([id*="last" i]):not([id*="company" i])'
      ], 
      value: process.env.USER_NAME || 'W. Ross Cromartie' 
    },
    // Email
    { 
      selectors: [
        'input[name*="email" i], input[type="email"]',
        'input[placeholder*="email" i]',
        'input[id*="email" i]'
      ], 
      value: process.env.USER_EMAIL || 'wcromartie@Orhlp.com' 
    },
    // Company
    { 
      selectors: [
        'input[name*="company" i], input[name*="organization" i], input[name*="firm" i]',
        'input[placeholder*="company" i], input[placeholder*="organization" i]',
        'input[id*="company" i], input[id*="organization" i]'
      ], 
      value: process.env.COMPANY_NAME || 'Odyssey Residential Holdings' 
    },
    // Phone
    { 
      selectors: [
        'input[name*="phone" i], input[type="tel"]',
        'input[placeholder*="phone" i], input[placeholder*="mobile" i]',
        'input[id*="phone" i], input[id*="mobile" i]'
      ], 
      value: process.env.USER_PHONE || '972-478-0485' 
    },
    // Title
    { 
      selectors: [
        'input[name*="title" i], input[name*="position" i], input[name*="job" i]',
        'input[placeholder*="title" i], input[placeholder*="position" i]',
        'input[id*="title" i], input[id*="position" i]'
      ], 
      value: process.env.USER_TITLE || 'Acquisitions Analyst' 
    },
    // Role/Industry Role
    { 
      selectors: [
        'input[name*="role" i], input[name*="industry" i]',
        'input[placeholder*="role" i], input[placeholder*="industry" i]',
        'input[id*="role" i], input[id*="industry" i]',
        'select[name*="role" i], select[name*="industry" i]'
      ], 
      value: process.env.USER_INDUSTRY_ROLE || 'Principal' 
    },
    // Address
    { 
      selectors: [
        'input[name*="address" i], input[name*="street" i]',
        'input[placeholder*="address" i], input[placeholder*="street" i]',
        'input[id*="address" i], input[id*="street" i]'
      ], 
      value: process.env.USER_ADDRESS || '13760 Noel Rd. STE 1000 Dallas, TX 75240' 
    }
  ];
  
  let filledAnyField = false;
  
  for (const field of formFields) {
    let fieldFilled = false;
    
    // Try each selector for this field type
    for (const selector of field.selectors) {
      try {
        const element = await page.$(selector);
        if (element) {
          const currentValue = await element.inputValue();
          if (!currentValue) {
            console.log(`RCM Handler: Filling ${selector} with "${field.value}"`);
            
            // Handle both input and select elements
            const tagName = await element.evaluate(el => el.tagName.toLowerCase());
            if (tagName === 'select') {
              await element.selectOption({ label: field.value });
            } else {
              await element.fill(field.value);
            }
            
            filledAnyField = true;
            fieldFilled = true;
            await page.waitForTimeout(500);
            break; // Found and filled, move to next field type
          }
        }
      } catch (error) {
        console.log(`RCM Handler: Error filling field ${selector}:`, error.message);
      }
    }
    
    if (fieldFilled) {
      console.log(`RCM Handler: Successfully filled field type with value "${field.value}"`);
    }
  }
  
  if (filledAnyField) {
    // Look for and check any required checkboxes after filling the form
    console.log('RCM Handler: Form filled, checking for required checkboxes...');
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
      
      console.log(`RCM Handler: Found form checkbox: "${labelText}"`);
      
      // Skip 1031 exchange checkboxes
      if (labelText.toLowerCase().includes('1031') && labelText.toLowerCase().includes('exchange')) {
        console.log('RCM Handler: Skipping 1031 exchange checkbox');
        continue;
      }
      
      // Check common required checkboxes (privacy, terms, etc.)
      const shouldCheck = labelText.toLowerCase().includes('agree') ||
                         labelText.toLowerCase().includes('accept') ||
                         labelText.toLowerCase().includes('privacy') ||
                         labelText.toLowerCase().includes('terms') ||
                         labelText.toLowerCase().includes('consent') ||
                         labelText.toLowerCase().includes('rcm lightbox');
      
      if (shouldCheck) {
        const isChecked = await checkbox.isChecked();
        if (!isChecked) {
          console.log('RCM Handler: Checking required checkbox');
          await checkbox.click();
          await page.waitForTimeout(500);
        }
      }
    } catch (error) {
      console.log('RCM Handler: Error handling form checkbox:', error);
    }
  }
}

async function handleAllCheckboxes(page: Page) {
  console.log('RCM Handler: Looking for all checkboxes to check...');
  
  // Look for all visible checkboxes on the page
  const checkboxes = await page.$$('input[type="checkbox"]');
  console.log(`RCM Handler: Found ${checkboxes.length} checkboxes total`);
  
  for (let i = 0; i < checkboxes.length; i++) {
    try {
      const checkbox = checkboxes[i];
      
      // Check if checkbox is visible
      const isVisible = await checkbox.isVisible().catch(() => false);
      if (!isVisible) {
        console.log(`RCM Handler: Checkbox ${i + 1} is not visible, skipping`);
        continue;
      }
      
      // Get the associated text/label for this checkbox
      const labelText = await page.evaluate((cb) => {
        // Try to find associated label text
        const id = cb.id;
        if (id) {
          const label = document.querySelector(`label[for="${id}"]`);
          if (label) return label.textContent || '';
        }
        
        // Try parent element text
        const parent = cb.closest('label') || cb.parentElement;
        return parent ? parent.textContent || '' : '';
      }, checkbox).catch(() => 'Unknown');
      
      console.log(`RCM Handler: Checkbox ${i + 1} text: "${labelText}"`);
      
      // Skip 1031 exchange related checkboxes
      if (labelText.toLowerCase().includes('1031')) {
        console.log('RCM Handler: Skipping 1031 exchange checkbox');
        continue;
      }
      
      // Skip checkboxes that look like search/filter controls
      if (labelText.toLowerCase().includes('highlight all') || 
          labelText.toLowerCase().includes('match case') || 
          labelText.toLowerCase().includes('whole words')) {
        console.log('RCM Handler: Skipping search control checkbox');
        continue;
      }
      
      // Check if it's already checked
      const isChecked = await checkbox.isChecked().catch(() => true);
      
      if (!isChecked) {
        console.log(`RCM Handler: Checking checkbox ${i + 1}: "${labelText}"`);
        
        // Try clicking the checkbox first
        try {
          await checkbox.click({ timeout: 2000 });
          console.log(`RCM Handler: Successfully clicked checkbox ${i + 1}`);
        } catch (error) {
          // If checkbox is intercepted, try clicking its label instead
          console.log(`RCM Handler: Checkbox click intercepted, trying label for checkbox ${i + 1}`);
          
          try {
            // Get the checkbox ID and find its label
            const checkboxId = await checkbox.getAttribute('id');
            if (checkboxId) {
              const label = await page.$(`label[for="${checkboxId}"]`);
              if (label) {
                await label.click({ timeout: 2000 });
                console.log(`RCM Handler: Successfully clicked label for checkbox ${i + 1}`);
              }
            } else {
              // Try clicking the parent label element
              const parentLabel = await page.evaluateHandle((cb) => cb.closest('label'), checkbox);
              if (parentLabel) {
                await parentLabel.click();
                console.log(`RCM Handler: Successfully clicked parent label for checkbox ${i + 1}`);
              }
            }
          } catch (labelError) {
            console.log(`RCM Handler: Could not click checkbox ${i + 1}:`, labelError.message);
          }
        }
        
        await page.waitForTimeout(500); // Small delay between clicks
      } else {
        console.log(`RCM Handler: Checkbox ${i + 1} already checked`);
      }
    } catch (error) {
      console.log(`RCM Handler: Error handling checkbox ${i + 1}:`, error.message);
    }
  }
  
  // Check if there's an "Agree to continue" message that indicates missing checkboxes
  const agreeMessage = await page.$('text=/agree to continue/i').catch(() => null);
  if (agreeMessage) {
    console.log('RCM Handler: Found "Agree to continue" message - may need to check more boxes');
  }
}

async function clickIfExists(page: Page, selector: string) {
  const el = await page.$(selector);
  if (el) {
    console.log(`RCM Handler: Found and clicking: ${selector}`);
    await el.click();
  } else {
    console.log(`RCM Handler: Element not found: ${selector}`);
  }
}

