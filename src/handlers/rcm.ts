// - RCM_ENTRY_GET_ACCESS:                                                                                                                                                                                                                                                                               
//   - Get Access → Main CA → Dealroom                                                                                                                                                                                                                                                                 
// - RCM_ENTRY_SAL_JAFAR:                                                                                                                                                                                                                                                                                
//    - Main CA → Not Sal Jafar → Main CA → Dealroom                                                                                                                                                                                                                                                    
// - RCM_ENTRY_MAIN_CA:                                                                                                                                                                                                                                                                                  
//    - Main CA → Dealroom                                                                                                                                                                                                                                                                              
                                          
import type { Page } from 'playwright';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';
import type { DealIngestionJob } from '../types.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fillFieldSmart, type FallbackRunContext } from './smartStep.js';
import { makeStagehandContext, writeStagehandStats } from '../audit/stagehandStats.js';

type RcmEntryKind = 'RCM_ENTRY_SAL_JAFAR' | 'RCM_ENTRY_MAIN_CA' | 'RCM_ENTRY_GET_ACCESS';

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

  // Stagehand fallback context (per-host gated) for this run
  const { ctx: shCtx, host, cfg } = makeStagehandContext(page, ctx.workingDir);

  // STEP 1: Check for Sal Jafar user selection FIRST
  let entryKind: RcmEntryKind = 'RCM_ENTRY_MAIN_CA';
  const hadSalJafar = await handleSalJafarSelection(page);

  // If we had Sal Jafar selection, wait for navigation and take new screenshot
  if (hadSalJafar) {
    entryKind = 'RCM_ENTRY_SAL_JAFAR';
    await page.waitForLoadState('networkidle').catch(()=>{});
    await page.screenshot({ path: 'runs/rcm-after-sal-jafar.png' }).catch(()=>{});
    console.log('RCM Handler: After Sal Jafar selection, current URL:', page.url());
  }
  
  // STEP 1.5: "Get Access" form page entry (alternate NDA/consent form)
  if (!hadSalJafar) {
    console.log('RCM Handler: Attempting Get Access entry...');
    const alt = await tryGetAccessEntry(page);
    if (alt) {
      entryKind = 'RCM_ENTRY_GET_ACCESS';
      await page.waitForLoadState('networkidle').catch(()=>{});
      await page.screenshot({ path: 'runs/rcm-after-get-access.png' }).catch(()=>{});
      console.log('RCM Handler: Get Access entry completed; current URL:', page.url());
    } else {
      console.log('RCM Handler: Get Access entry failed or not applicable');
    }
  }

  // If we still didn't detect the other two paths, we assume main CA entry
  if (!hadSalJafar && entryKind !== 'RCM_ENTRY_GET_ACCESS') {
    entryKind = 'RCM_ENTRY_MAIN_CA';
  }

  // Persist entry kind for audit/debug
  try {
    await fs.writeFile(path.join(ctx.workingDir, 'rcm-entry.txt'), entryKind, 'utf8');
  } catch {}
  console.log('RCM Handler: Entry kind =', entryKind);

  // STEP 2: Handle user info form if present
  await handleUserInfoForm(page, shCtx);
  
  // STEP 3: Handle checkboxes (avoiding 1031 exchange) once more, just in case
  console.log('RCM Handler: Looking for checkboxes to check...');
  await handleAllCheckboxes(page);

  // STEP 3.5: Reset validation (blur + outside click) before any submit/continue
  await tryAdvanceFromMainCa(page);

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

  if (archive) {
    await writeStagehandStats(ctx.workingDir, host, cfg, shCtx).catch(() => {});
    return outDir;
  }

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
  await writeStagehandStats(ctx.workingDir, host, cfg, shCtx).catch(() => {});
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

async function handleUserInfoForm(page: Page, shCtx?: FallbackRunContext) {
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
      value: process.env.USER_NAME || '' 
    },
    // Email
    { 
      selectors: [
        'input[name*="email" i], input[type="email"]',
        'input[placeholder*="email" i]',
        'input[id*="email" i]'
      ], 
      value: process.env.USER_EMAIL || '' 
    },
    // Company
    { 
      selectors: [
        'input[name*="company" i], input[name*="organization" i], input[name*="firm" i]',
        'input[placeholder*="company" i], input[placeholder*="organization" i]',
        'input[id*="company" i], input[id*="organization" i]'
      ], 
      value: process.env.USER_COMPANY || '' 
    },
    // Phone
    { 
      selectors: [
        'input[name*="phone" i], input[type="tel"]',
        'input[placeholder*="phone" i], input[placeholder*="mobile" i]',
        'input[id*="phone" i], input[id*="mobile" i]'
      ], 
      value: process.env.USER_PHONE || '' 
    },
    // Title
    { 
      selectors: [
        'input[name*="title" i], input[name*="position" i], input[name*="job" i]',
        'input[placeholder*="title" i], input[placeholder*="position" i]',
        'input[id*="title" i], input[id*="position" i]'
      ], 
      value: process.env.USER_TITLE || '' 
    },
    // Role/Industry Role
    { 
      selectors: [
        'input[name*="role" i], input[name*="industry" i]',
        'input[placeholder*="role" i], input[placeholder*="industry" i]',
        'input[id*="role" i], input[id*="industry" i]',
        'select[name*="role" i], select[name*="industry" i]'
      ], 
      value: process.env.USER_INDUSTRY_ROLE || '' 
    },
    // Address
    { 
      selectors: [
        'input[name*="address" i], input[name*="street" i]',
        'input[placeholder*="address" i], input[placeholder*="street" i]',
        'input[id*="address" i], input[id*="street" i]'
      ], 
      value: process.env.USER_ADDRESS || '' 
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
  
  if (!filledAnyField && shCtx) {
    // Deterministic did not fill anything; attempt Stagehand fallback for common fields
    try {
      const candidates: Array<[string, string]> = [
        ['Email', process.env.USER_EMAIL || 'test@example.com'],
        ['First Name', process.env.USER_FIRST_NAME || 'Test'],
        ['Last Name', process.env.USER_LAST_NAME || 'User'],
        ['Company', process.env.USER_COMPANY || process.env.COMPANY || 'Example Company LLC'],
        ['Phone', process.env.USER_PHONE || '(555) 123-4567']
      ];
      for (const [label, value] of candidates) {
        try {
          const res = await fillFieldSmart(page, label, value, { ctx: shCtx });
          if (res?.method === 'deterministic' || res?.method === 'stagehand') {
            filledAnyField = true;
          }
        } catch {}
      }
    } catch {}
  }

  // Always check form checkboxes even if fields were prefilled
  console.log('RCM Handler: Checking required form checkboxes...');
  await handleFormCheckboxes(page);
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
                // Try clicking the parent label element via JS
                try {
                  await page.evaluate((cb: any) => {
                    const lb = (cb as HTMLElement).closest('label') as HTMLElement | null;
                    lb?.click?.();
                  }, checkbox);
                  console.log(`RCM Handler: Successfully clicked parent label for checkbox ${i + 1}`);
                } catch {}
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

// --- "Get Access" entry helpers (JS-driven, frame-aware) ---
async function tryGetAccessEntry(page: Page) {
  try {
    const gate = await page.$('text=/I\\s*Agree|Accept|Confidential|Confidentiality|Non[-\\s]?Disclosure|NDA/i');
    const anyCheckbox = await page.$('input[type="checkbox"], [role="checkbox"]');
    if (!gate && !anyCheckbox) return false;

    console.log('RCM Handler: Attempting "Get Access" entry (NDA/consent)...');
    await ensureAgreementChecked(page);
    await blurAndTriggerValidation(page);
    const hasErrors = await hasValidationErrors(page);
    if (hasErrors) {
      console.log('RCM Handler: Validation errors present; skipping auto-submit');
      return true; // handled but cannot submit
    }

    // Click likely submit/continue using JS with navigation verification
    console.log('RCM Handler: Attempting to submit Get Access form...');
    const currentUrl = page.url();
    
    let submitted = await jsClickByText(page, ['Submit', 'Continue', 'Request Access', 'Get Access', 'Proceed'], true);
    if (!submitted) {
      console.log('RCM Handler: Text-based click failed, trying selectors...');
      submitted = await jsClickSelector(page, [
        'button[type="submit"], input[type="submit"]',
        'button:has-text("Submit")',
        'button:has-text("Continue")',
        'button:has-text("Request Access")',
        'button:has-text("Get Access")'
      ], true);
    }
    
    if (submitted) {
      await page.waitForLoadState('networkidle').catch(()=>{});
      const newUrl = page.url();
      
      if (newUrl !== currentUrl) {
        console.log(`RCM Handler: Get Access form successfully submitted! ${currentUrl} → ${newUrl}`);
        return true;
      } else {
        console.log('RCM Handler: Button clicked but Get Access form did not navigate - may need manual intervention');
        return false; // Don't claim success if we didn't navigate
      }
    }
    
    console.log('RCM Handler: Could not submit Get Access form');
    return false;
  } catch {}
  return false;
}

async function ensureAgreementChecked(page: Page) {
  const patterns = /(i\\s*agree|accept|terms|privacy|nda|confidential|confidentiality|non[-\\s]?disclosure|consent)/i;
  // Obvious checkboxes by selector
  await jsSetCheckbox(page, [
    'input[type="checkbox"][name*="agree" i]',
    'input[type="checkbox"][id*="agree" i]',
    'input[type="checkbox"][name*="terms" i]',
    'input[type="checkbox"][id*="terms" i]',
    'input[type="checkbox"][name*="confidential" i]',
    'input[type="checkbox"][id*="confidential" i]'
  ]);
  // Labels and ARIA
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
            if ((box as HTMLInputElement).tagName === 'INPUT') {
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
    }, patterns.source).catch(() => {});
  }
}

async function blurAndTriggerValidation(page: Page) {
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      const fields = Array.from(document.querySelectorAll('input, textarea, select')) as HTMLElement[];
      for (const el of fields) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      (document.activeElement as HTMLElement | null)?.blur?.();
    }).catch(()=>{});
  }
  try { await page.mouse.click(2, 2); } catch {}
  await page.waitForTimeout(300);
}

async function hasValidationErrors(page: Page) {
  for (const frame of page.frames()) {
    const anyErrors = await frame.evaluate(() => {
      const collectText = (sel: string) => Array.from(document.querySelectorAll(sel)).map(e => (e as HTMLElement).innerText || (e as HTMLElement).textContent || '').map(s => s.trim()).filter(Boolean);
      const messages: string[] = [];
      const push = (arr: string[]) => { for (const s of arr) if (s) messages.push(s); };
      push(collectText('[role="alert"]'));
      push(collectText('.error, .errors, .invalid-feedback, .validation-error, .field-error, .help-block, .ant-form-item-explain-error, .MuiFormHelperText-root.Mui-error, .error-message'));
      const inputs = Array.from(document.querySelectorAll('input, textarea, select')) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];
      for (const el of inputs) {
        const ai = el.getAttribute('aria-invalid');
        const bad = ai === 'true' || (typeof (el as any).checkValidity === 'function' && !(el as any).checkValidity());
        if (bad) return true;
      }
      return messages.length > 0;
    }).catch(()=>false);
    if (anyErrors) return true;
  }
  return false;
}

async function jsSetCheckbox(page: Page, selectors: string[]) {
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

async function jsClickSelector(page: Page, selectors: string[], expectNavigation = false) {
  const currentUrl = page.url();
  console.log(`RCM Handler: Looking for buttons with selectors: ${selectors.join(', ')}`);
  
  for (const frame of page.frames()) {
    for (const sel of selectors) {
      const el = await frame.$(sel);
      if (!el) continue;
      
      const elementInfo = await frame.evaluate((node: Element) => {
        const el = node as HTMLElement;
        return {
          text: (el.innerText || el.textContent || '').trim(),
          tagName: el.tagName.toLowerCase(),
          disabled: (el as any).disabled || false
        };
      }, el);
      
      console.log(`RCM Handler: Found element with selector "${sel}": ${elementInfo.tagName}:"${elementInfo.text}"${elementInfo.disabled ? ' (disabled)' : ''}`);
      
      if (elementInfo.disabled) {
        console.log('RCM Handler: Element is disabled, skipping');
        continue;
      }
      
      const ok = await frame.evaluate((node: Element) => {
        try {
          const el = node as HTMLElement;
          el.scrollIntoView?.({ block: 'center', inline: 'center' });
          
          // Try multiple click methods
          const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
          node.dispatchEvent(evt);
          el.click?.();
          
          // If it's a form button, try submitting the form
          const form = el.closest('form');
          if (form && (el as any).type === 'submit') {
            console.log('Attempting form submission via selector');
            form.submit();
          }
          
          return true;
        } catch (e) {
          console.log('Selector click failed:', e);
          return false;
        }
      }, el).catch(() => false);
      
      if (ok) {
        console.log(`RCM Handler: Successfully clicked element: "${elementInfo.text}" (${elementInfo.tagName})`);
        
        if (expectNavigation) {
          console.log('RCM Handler: Waiting for navigation...');
          await page.waitForTimeout(2000); // Wait for potential navigation
          const newUrl = page.url();
          
          if (newUrl !== currentUrl) {
            console.log(`RCM Handler: Navigation successful! ${currentUrl} → ${newUrl}`);
            await page.waitForLoadState('networkidle').catch(() => {});
            return true;
          } else {
            console.log('RCM Handler: Element clicked but no navigation occurred');
            return true; // Still return true as element was clicked
          }
        } else {
          await page.waitForTimeout(500); // Small delay for non-navigation clicks
          return true;
        }
      }
    }
  }
  
  console.log('RCM Handler: No matching selectors found or clickable');
  return false;
}

async function jsClickByText(page: Page, texts: string[], expectNavigation = false) {
  const currentUrl = page.url();
  console.log(`RCM Handler: Looking for buttons with text: ${texts.join(', ')}`);
  
  // First, find and log all potential buttons
  const buttons = await page.evaluate((needles: any) => {
    const candidates = Array.from(document.querySelectorAll('button, a, label, input[type="button"], input[type="submit"]')) as HTMLElement[];
    const found: { text: string; tagName: string; disabled: boolean; visible: boolean }[] = [];
    
    for (const el of candidates) {
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt) {
        const style = window.getComputedStyle(el);
        found.push({
          text: txt,
          tagName: el.tagName.toLowerCase(),
          disabled: (el as any).disabled || false,
          visible: style.display !== 'none' && style.visibility !== 'hidden'
        });
      }
    }
    return found;
  });
  
  console.log(`RCM Handler: Found ${buttons.length} buttons on page:`, buttons.map(b => `${b.tagName}:"${b.text}"(${b.disabled ? 'disabled' : 'enabled'}, ${b.visible ? 'visible' : 'hidden'})`));
  
  for (const frame of page.frames()) {
    const clickResult = await frame.evaluate((needles: any) => {
      const candidates = Array.from(document.querySelectorAll('button, a, label, input[type="button"], input[type="submit"]')) as HTMLElement[];
      for (const n of needles) {
        const re = new RegExp(n, 'i');
        for (const el of candidates) {
          const txt = (el.innerText || el.textContent || '').trim();
          if (txt && re.test(txt)) {
            console.log(`Found matching button: "${txt}" (${el.tagName})`);
            try {
              el.scrollIntoView?.({ block: 'center', inline: 'center' });
              
              // Try multiple click methods
              const evt = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
              el.dispatchEvent(evt);
              el.click?.();
              
              // If it's a form button, try submitting the form
              const form = el.closest('form');
              if (form && (el as any).type === 'submit') {
                console.log('Attempting form submission');
                form.submit();
              }
              
              return { clicked: true, text: txt, tagName: el.tagName };
            } catch (e) {
              console.log('Click failed:', e);
              return { clicked: false, text: txt, error: e.message };
            }
          }
        }
      }
      return { clicked: false };
    }, texts).catch(() => ({ clicked: false }));
    
    if ((clickResult as any).clicked) {
      const cr: any = clickResult as any;
      console.log(`RCM Handler: Successfully clicked button: "${cr.text}" (${cr.tagName})`);
      
      if (expectNavigation) {
        console.log('RCM Handler: Waiting for navigation...');
        await page.waitForTimeout(2000); // Wait for potential navigation
        const newUrl = page.url();
        
        if (newUrl !== currentUrl) {
          console.log(`RCM Handler: Navigation successful! ${currentUrl} → ${newUrl}`);
          await page.waitForLoadState('networkidle').catch(() => {});
          return true;
        } else {
          console.log('RCM Handler: Button clicked but no navigation occurred');
          // Still return true as button was clicked, let caller decide if navigation is required
          return true;
        }
      } else {
        await page.waitForTimeout(500); // Small delay for non-navigation clicks
        return true;
      }
    }
  }
  
  console.log('RCM Handler: No matching buttons found or clickable');
  return false;
}

async function tryAdvanceFromMainCa(page: Page) {
  // Detect main CA context heuristically (URL or common elements)
  const url = page.url();
  const onMainCa = /\/buyer\/findprofile/i.test(url) || !!(await page.$('input[type="email"], input[name*="email" i]').catch(()=>null));
  if (!onMainCa) return false;
  console.log('RCM Handler: On Main CA; attempting to advance...');
  await blurAndTriggerValidation(page);
  const hasErrors = await hasValidationErrors(page);
  if (hasErrors) {
    console.log('RCM Handler: Main CA validation errors present; not submitting.');
    return false;
  }
  console.log(`RCM Handler: Current URL before attempting to advance: ${url}`);
  
  let advanced = await jsClickByText(page, [
    'I Agree', 'Get Access', 'Request Access', 'Continue', 'Proceed', 'Submit', 'Next', 'Accept'
  ], true); // Expect navigation
  
  if (!advanced) {
    console.log('RCM Handler: Text-based advance failed, scrolling and retrying...');
    await scrollAllFrames(page);
    await page.waitForTimeout(200);
    advanced = await jsClickByText(page, [
      'I Agree', 'Get Access', 'Request Access', 'Continue', 'Proceed', 'Submit', 'Next', 'Accept'
    ], true);
  }
  
  if (!advanced) {
    console.log('RCM Handler: Text retry failed, trying selectors...');
    advanced = await jsClickSelector(page, [
      'button:has-text("I Agree")', 'button:has-text("Get Access")', 'a:has-text("Get Access")', '[role="button"]:has-text("Get Access")',
      'button:has-text("Request Access")', 'a:has-text("Request Access")',
      'button:has-text("Continue")', 'button:has-text("Proceed")',
      'button:has-text("Submit")', 'input[type="submit"]',
      'button:has-text("Accept")', 'button[value*="Agree"], input[value*="Agree"]'
    ], true); // Expect navigation
  }
  if (advanced) {
    console.log('RCM Handler: Advanced from Main CA.');
    await page.waitForLoadState('networkidle').catch(()=>{});
    return true;
  }
  console.log('RCM Handler: Could not find advance button on Main CA.');
  return false;
}

async function scrollAllFrames(page: Page, steps = 3) {
  for (let i = 0; i < steps; i++) {
    for (const frame of page.frames()) {
      await frame.evaluate(() => {
        try {
          window.scrollBy(0, Math.max(200, Math.floor(window.innerHeight * 0.9)));
        } catch {}
      }).catch(()=>{});
    }
    await page.waitForTimeout(150);
  }
}
