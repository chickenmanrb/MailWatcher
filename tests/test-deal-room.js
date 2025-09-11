import 'dotenv/config';
import { chromium } from 'playwright';
import { createBrowserContext } from '../src/browser/session.ts';
import { clickDownloadAll } from '../src/browser/download.ts';
import { uploadFolderToSharePoint } from '../src/upload/sharepoint.ts';
import path from 'node:path';
import fs from 'node:fs/promises';

async function testDealRoom() {
  const dealRoomUrl = 'https://my.rcm1.com/buyer/vdr?pv=tfdWF52G4dNO3VQXhKmvx8ALKi4f_zVbqyQFM9P-jfDw2ylT6_CwulULFUWRM3CODTo80eV1jnkhha0j7S3bCA';
  const sharepointUrl = 'https://odysseyresidentialholdings.sharepoint.com/:f:/s/ORHAcquisitions/EiW9r4PDQ-FIlnykUySqtEABBhFj8XKFeoSW8AA4-aqEYg?e=uLnYlY';
  
  console.log('Starting deal room download test...');
  
  const browser = await chromium.launch({ headless: false });
  
  // Create context with download settings
  const ctx = await browser.newContext({
    acceptDownloads: true,
    // Set download directory
    ...(await import('../src/browser/session.js').then(m => m.getStorageState('rcm1.com')).catch(() => ({})))
  });
  const page = await ctx.newPage();
  
  // Create output directory
  const outDir = path.join(process.cwd(), 'runs', `deal-room-${Date.now()}`);
  await fs.mkdir(outDir, { recursive: true });
  
  try {
    // Navigate to deal room
    console.log('Navigating to deal room...');
    await page.goto(dealRoomUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    
    console.log('Current URL:', page.url());
    await page.screenshot({ path: 'runs/deal-room-page.png' });
    
    // First select all files using JavaScript click on the header "select all" checkbox
    console.log('Step 1: Looking for header "select all" checkbox...');
    
    // Target the header checkbox specifically (the one you circled)
    const headerCheckboxSelectors = [
      'thead input[type="checkbox"]', // Header checkbox in table header
      'th input[type="checkbox"]',    // Checkbox in table header cell
      '.table-header input[type="checkbox"]',
      'input[type="checkbox"]:first-of-type' // First checkbox (usually the select-all)
    ];
    
    let headerCheckboxFound = false;
    
    for (const selector of headerCheckboxSelectors) {
      try {
        const headerCheckbox = await page.$(selector);
        if (headerCheckbox) {
          const isVisible = await headerCheckbox.isVisible().catch(() => false);
          
          if (isVisible) {
            console.log(`Found header select-all checkbox: ${selector}`);
            // Use JavaScript click for reliability
            await page.evaluate((cb) => cb.click(), headerCheckbox);
            console.log('Successfully JavaScript-clicked header select-all checkbox');
            headerCheckboxFound = true;
            break;
          }
        }
      } catch (error) {
        console.log(`Error with selector ${selector}:`, error.message);
      }
    }
    
    if (!headerCheckboxFound) {
      console.log('Header checkbox not found, trying individual checkboxes...');
      // Fallback: click all visible checkboxes
      const checkboxes = await page.$$('input[type="checkbox"]');
      console.log(`Found ${checkboxes.length} total checkboxes`);
      
      for (let i = 0; i < checkboxes.length; i++) {
        try {
          const checkbox = checkboxes[i];
          const isVisible = await checkbox.isVisible().catch(() => false);
          
          if (isVisible) {
            await page.evaluate((cb) => cb.click(), checkbox);
            console.log(`Successfully JavaScript-clicked checkbox ${i + 1}`);
            await page.waitForTimeout(200);
          }
        } catch (error) {
          console.log(`Error clicking checkbox ${i + 1}:`, error.message);
        }
      }
    }
    
    // Wait a moment for selections to register
    await page.waitForTimeout(1000);
    
    // Check if download button is now enabled
    const downloadButton = await page.$('button:has-text("Download")');
    if (downloadButton) {
      const isEnabled = await downloadButton.isEnabled();
      console.log(`Download button enabled: ${isEnabled}`);
      
      if (isEnabled) {
        console.log('Step 2: Clicking Download button and waiting for download...');
        
        // Set up download promise to wait for download completion
        const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
        
        try {
          await page.evaluate((btn) => btn.click(), downloadButton);
          console.log('Successfully JavaScript-clicked Download button');
          
          // Handle download confirmation popup
          console.log('Looking for Download Confirmation popup...');
          await page.waitForTimeout(1000); // Wait for popup to appear
          
          const confirmationSelectors = [
            'button:has-text("Okay")',
            'button:has-text("OK")', 
            'button:has-text("Yes")',
            'button:has-text("Confirm")',
            'button:has-text("Download")',
            '[role="dialog"] button:has-text("Okay")',
            '[role="dialog"] button:has-text("OK")',
            '.modal button:has-text("Okay")',
            '.modal button:has-text("OK")'
          ];
          
          let confirmationClicked = false;
          for (const selector of confirmationSelectors) {
            try {
              const confirmBtn = await page.$(selector);
              if (confirmBtn) {
                const isVisible = await confirmBtn.isVisible();
                if (isVisible) {
                  console.log(`Found confirmation button: ${selector}`);
                  await page.evaluate((btn) => btn.click(), confirmBtn);
                  console.log('Successfully clicked confirmation Okay button');
                  confirmationClicked = true;
                  break;
                }
              }
            } catch (error) {
              console.log(`Error with confirmation selector ${selector}:`, error.message);
            }
          }
          
          if (!confirmationClicked) {
            console.log('No confirmation popup found, proceeding...');
          }
          
          // Wait for download to start and complete
          console.log('Waiting for download to complete...');
          const download = await downloadPromise;
          console.log('Download started:', download.suggestedFilename());
          
          // Save the download to our output directory
          const downloadPath = path.join(outDir, download.suggestedFilename() || 'download.zip');
          await download.saveAs(downloadPath);
          console.log('Download saved to:', downloadPath);
          
          // Take screenshot after download completed
          await page.screenshot({ path: 'runs/deal-room-after-download.png' });
          
          // Now upload to SharePoint
          console.log('Step 3: Uploading to SharePoint...');
          try {
            await uploadFolderToSharePoint(outDir, sharepointUrl);
            console.log('Successfully uploaded to SharePoint!');
          } catch (uploadError) {
            console.log('SharePoint upload failed:', uploadError.message);
          }
          
          return outDir; // Return success
        } catch (error) {
          console.log('Download failed:', error.message);
          
          // Fallback: Take screenshot for debugging
          await page.screenshot({ path: 'runs/deal-room-download-failed.png' });
        }
      }
    }
    
    // Fallback: Try the original clickDownloadAll approach
    console.log('Fallback: Attempting clickDownloadAll...');
    const downloadSelectors = [
      'button:has-text("Download All")',
      'button:has-text("Download")', 
      'button[title*="Download All"]',
      'button[title*="Download"]',
      '.download-all',
      '#download-all'
    ];
    
    const archive = await clickDownloadAll(page, downloadSelectors, outDir).catch((error) => {
      console.log('clickDownloadAll failed:', error.message);
      return null;
    });
    
    if (archive) {
      console.log('Download successful! Archive location:', archive);
      // SharePoint upload already handled above
    } else {
      console.log('clickDownloadAll did not find download options, checking page content...');
      
      // Debug: Show what's on the page
      const pageTitle = await page.title();
      console.log('Page title:', pageTitle);
      
      // Look for any download-related elements
      const downloadElements = await page.$$eval('[href*="download"], [onclick*="download"], button:has-text("Download"), a:has-text("Download")', 
        elements => elements.map(el => ({ 
          tagName: el.tagName, 
          text: el.textContent?.trim(), 
          href: el.href,
          onclick: el.onclick?.toString()
        }))
      ).catch(() => []);
      
      console.log('Found download-related elements:', downloadElements);
      
      // Take screenshot for debugging
      await page.screenshot({ path: 'runs/deal-room-debug.png' });
    }
    
  } catch (error) {
    console.error('Error:', error);
    await page.screenshot({ path: 'runs/deal-room-error.png' });
  } finally {
    if (process.env.KEEP_BROWSER_OPEN !== 'true') {
      await ctx.close();
      await browser.close();
    } else {
      console.log('Browser kept open for inspection...');
      console.log('Press Ctrl+C when ready to close.');
      await new Promise(() => {}); // Keep alive
    }
  }
}

testDealRoom().catch(console.error);