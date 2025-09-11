import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createBrowserContext } from '../browser/session.js';
import { handleUniversalDealroom } from '../handlers/universal.js';
import { uploadFolderToSharePoint, resolveFolderId } from '../upload/sharepoint.js';

function getArg(k: string) {
  const hit = process.argv.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}

function requireVal(name: string, val?: string) {
  if (!val || !val.trim()) throw new Error(`Missing required ${name}. Provide via --${name.replaceAll('_','-')}=... or environment variable.`);
  return val.trim();
}

function safeHost(u: string) {
  try { return new URL(u).hostname.replace(/[^a-z0-9.-]+/gi, '_').toLowerCase(); } catch { return 'dealroom'; }
}

async function main() {
  const dealroomUrl = getArg('url') || process.env.DEALROOM_URL || '';
  const sharepointFolderId = getArg('spid') || getArg('sharepointId') || getArg('sharepoint_folder_id') || process.env.SHAREPOINT_FOLDER_ID || process.env.sharepoint_folder_id || '';
  const sharepointFolderUrl = getArg('spurl') || getArg('sharepointUrl') || process.env.SHAREPOINT_FOLDER_URL || '';

  requireVal('url', dealroomUrl);
  if (!sharepointFolderId && !sharepointFolderUrl) {
    throw new Error('Missing SharePoint destination. Provide either --spid=<DriveItem ID or UniqueId GUID> or --spurl=<folder web URL>.');
  }

  const host = safeHost(dealroomUrl);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const workingDir = path.join('runs', `d2d-${host}-${ts}`);
  await fs.mkdir(workingDir, { recursive: true });

  const browser = await chromium.launch({ headless: false });
  const ctx = await createBrowserContext(browser, host, {
    recordHar: { path: path.join(workingDir, 'network.har'), content: 'embed' }
  });
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await ctx.newPage();

  try {
    console.log('[d2d] navigating to deal room:', dealroomUrl);
    const job = { task_name: `d2d-${host}-${Date.now()}` } as any;
    const downloadedRoot = await handleUniversalDealroom(page, { job, workingDir, urls: [dealroomUrl] });
    console.log('[d2d] downloaded assets to:', downloadedRoot);

    // Inspect downloaded folder contents
    const files: string[] = [];
    for await (const fp of walk(downloadedRoot)) files.push(fp);
    const rel = files.map(f => path.relative(downloadedRoot, f));
    await fs.writeFile(path.join(workingDir, 'download-contents.json'), JSON.stringify(rel, null, 2), 'utf8').catch(()=>{});
    console.log(`[d2d] downloaded file count: ${files.length}`);
    if (files.length === 0) {
      console.warn('[d2d] No files found to upload. See screenshots in workingDir and download-contents.json');
    }

    let receipts: Array<any> = [];
    if (sharepointFolderUrl) {
      console.log('[d2d] uploading to SharePoint via webUrl');
      receipts = await uploadFolderToSharePoint(downloadedRoot, sharepointFolderUrl, undefined, workingDir);
    } else {
      // Resolve GUID uniqueId -> DriveItem id if needed
      const resolved = await resolveFolderId(sharepointFolderId).catch((e) => {
        console.error('[d2d] could not resolve SharePoint id', e?.message || e);
        throw e;
      });
      console.log('[d2d] uploading to SharePoint folder:', { driveId: resolved.driveId, itemId: resolved.itemId, webUrl: resolved.webUrl || '' });
      receipts = await uploadFolderToSharePoint(downloadedRoot, undefined, resolved.itemId, workingDir);
    }
    console.log('[d2d] upload complete. Receipt entries:', receipts.length);
    for (const r of receipts) {
      console.log(`  + ${path.basename(r.localPath)} -> ${r.webUrl || r.itemId} (${r.bytes} bytes)`);
    }
    console.log('[d2d] receipt file:', path.join(workingDir, 'upload-receipt.json'));

    if (process.env.KEEP_BROWSER_OPEN === 'true') {
      console.log('[d2d] Keeping browser open for inspection. Press Ctrl+C to exit.');
      await new Promise(() => {});
    }
  } catch (err: any) {
    console.error('[d2d] error:', err?.message || err);
    if (process.env.KEEP_BROWSER_OPEN !== 'true') {
      try { await ctx.tracing.stop({ path: path.join(workingDir, 'trace.zip') }); } catch {}
      try { await ctx.close(); } catch {}
      try { await browser.close(); } catch {}
    } else {
      console.log('[d2d] Browser kept open after error. Press Ctrl+C to exit.');
      await new Promise(() => {});
    }
    return;
  }

  try { await ctx.tracing.stop({ path: path.join(workingDir, 'trace.zip') }); } catch {}
  await ctx.close();
  await browser.close();
}

async function* walk(dir: string): AsyncGenerator<string> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) yield* walk(p);
      else yield p;
    }
  } catch {}
}

main().catch(err => { console.error(err); process.exit(1); });
