import 'dotenv/config';
import { chromium } from 'playwright';
import { fetchNdaUrl } from './notion/fetchNdaUrl.js';
import { detectPlatform } from './detect/detectPlatform.js';
import { createBrowserContext } from './browser/session.js';
import { handleBuildout } from './handlers/buildout.js';
import { handleCrexi } from './handlers/crexi.js';
import { handleRcm } from './handlers/rcm.js';
import { handleGeneric } from './handlers/generic.js';
import { uploadFolderToSharePoint } from './upload/sharepoint.js';
import { writeAudit } from './audit/auditLog.js';
import { zipArtifacts } from './audit/zipArtifacts.js';
import type { DealIngestionJob } from './types.js';

async function run(job: DealIngestionJob) {
  console.log('Starting job:', job.task_name);
  const ndalink = job.nda_url ?? (job.notion_page_id ? await fetchNdaUrl(job.notion_page_id) : undefined);
  const candidateUrls = [job.dealroom_url, ndalink, job.sharepoint_folder_webUrl, ...extractLinks(job.email_body || '')]
    .filter(Boolean) as string[];

  const detection = detectPlatform(candidateUrls);
  const browser = await chromium.launch({ headless: false }); // Set to false for debugging
  const ctx = await createBrowserContext(browser, detection.domainKey);

  const workingDir = `runs/${Date.now()}-${sanitize(job.task_name)}`;
  const page = await ctx.newPage();

  let downloadedRoot: string;

  try {
    switch (detection.kind) {
      case 'buildout':
        downloadedRoot = await handleBuildout(page, { job, workingDir, urls: detection.urls });
        break;
      case 'crexi':
        downloadedRoot = await handleCrexi(page, { job, workingDir, urls: detection.urls });
        break;
      case 'rcm':
        downloadedRoot = await handleRcm(page, { job, workingDir, urls: detection.urls });
        break;
      default:
        downloadedRoot = await handleGeneric(page, { job, workingDir, urls: detection.urls });
    }

    await uploadFolderToSharePoint(downloadedRoot, job.sharepoint_folder_webUrl, job.sharepoint_folder_id);

    const receipt = await writeAudit(workingDir, { job, detection, downloadedRoot });
    await zipArtifacts(workingDir);
    console.log(JSON.stringify({ ok: true, receipt }, null, 2));
    
    // Keep browser open on success for verification if requested
    if (process.env.KEEP_BROWSER_OPEN === 'true') {
      console.log('==========================================');
      console.log('SUCCESS - Browser kept open for verification');
      try {
        console.log('Final URL:', await page.url());
        console.log('Page title:', await page.title());
      } catch {
        console.log('Final URL: unknown');
        console.log('Page title: unknown');
      }
      console.log('==========================================');
      console.log('Process completed successfully!');
      console.log('Please verify the results in the browser window.');
      console.log('Press Ctrl+C when ready to close.');
      
      // Wait indefinitely until user closes manually
      await new Promise(() => {}); // This will keep the process alive
    }
  } catch (error) {
    console.error('Error during execution:', error);
    
    // Check if we should keep browser open even on error
    if (true) { // Temporarily hardcode to always keep browser open
      console.log('==========================================');
      console.log('ERROR OCCURRED - Browser kept open for inspection');
      try {
        console.log('Current URL:', await page.url());
        console.log('Page title:', await page.title());
      } catch {
        console.log('Current URL: unknown');
        console.log('Page title: unknown');
      }
      console.log('==========================================');
      console.log('Please inspect the browser window and close it manually when done.');
      console.log('Process will continue running to keep browser open...');
      console.log('Press Ctrl+C when ready to close.');
      
      // Wait indefinitely until user closes manually - DON'T throw error
      await new Promise(() => {}); // This will keep the process alive
    } else {
      // Standard error behavior - keep browser open briefly then close
      console.log('==========================================');
      console.log('ERROR OCCURRED - Browser kept open briefly for inspection');
      try {
        console.log('Current URL:', await page.url());
        console.log('Page title:', await page.title());
      } catch {
        console.log('Current URL: unknown');
        console.log('Page title: unknown');
      }
      console.log('==========================================');
      console.log('Please inspect the browser window and close it manually when done.');
      
      // Wait a bit to ensure user sees the message before potential process exit
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      throw error;
    }
  } finally {
    // Enhanced browser management
    if (process.env.KEEP_BROWSER_OPEN === 'true') {
      console.log('==========================================');
      console.log('BROWSER KEPT OPEN FOR VERIFICATION');
      try {
        console.log('Current URL:', await page.url());
        console.log('Page title:', await page.title());
      } catch {
        console.log('Current URL: unknown');
        console.log('Page title: unknown');
      }
      console.log('==========================================');
      console.log('Please verify the form submission result in the browser window.');
      console.log('Close the browser manually when you are done inspecting.');
      
      // Keep the process alive for manual inspection
      console.log('Process will continue running to keep browser open...');
      console.log('Press Ctrl+C when ready to close.');
      
      // Wait indefinitely until user closes manually
      await new Promise(() => {}); // This will keep the process alive
    } else {
      // Standard cleanup
      await ctx.close();
      await browser.close();
    }
  }
}

function extractLinks(emailHtml: string): string[] {
  const re = /https?:\/\/[^\s"'<>]+/g;
  return emailHtml?.match(re) ?? [];
}

function sanitize(s: string) {
  return s.replace(/[^a-z0-9-_]+/gi, '_').toLowerCase();
}

// CLI usage for quick tests
if (process.argv[2]) {
  const arg = process.argv[2];
  let job: DealIngestionJob;
  
  // Support both JSON string and file path
  if (arg.startsWith('{')) {
    job = JSON.parse(arg);
  } else {
    const fs = await import('node:fs/promises');
    const fileContent = await fs.readFile(arg, 'utf-8');
    job = JSON.parse(fileContent);
  }
  
  run(job).catch(e => { console.error(e); process.exit(1); });
}
export { run };

