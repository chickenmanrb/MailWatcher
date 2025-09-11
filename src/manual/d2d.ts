import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { handleUniversalDealroom } from '../handlers/universal.js';
import { uploadFolderToSharePointByPath } from '../upload/sharepoint.js';

function getArg(k: string) {
  const argv = process.argv;
  // Support both --key=value and --key value forms
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${k}`) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) return next;
    }
    if (a.startsWith(`--${k}=`)) {
      return a.substring(`--${k}=`.length);
    }
  }
  // npm exposes --key=value as npm_config_key in env when invoked via npm scripts
  const npmCfg = process.env[`npm_config_${k}` as keyof NodeJS.ProcessEnv] as string | undefined;
  return npmCfg;
}

function requireVal(name: string, val?: string) {
  if (!val || !val.trim()) {
    const flag = `--${name.replaceAll('_','-')}`;
    const hint = name.toLowerCase() === 'url'
      ? ` If the URL contains & or ?, quote it in your shell (e.g., PowerShell: ${flag}="https://...&...", Bash: ${flag}='https://...&...').`
      : '';
    throw new Error(`Missing required ${name}. Provide via ${flag}=... or environment variable.${hint}`);
  }
  return val.trim();
}

function safeHost(u: string) {
  try { return new URL(u).hostname.replace(/[^a-z0-9.-]+/gi, '_').toLowerCase(); } catch { return 'dealroom'; }
}

async function main() {
  const dealroomUrl = getArg('url') || process.env.DEALROOM_URL || '';
  const sharepointServerRelativePath = getArg('sprel') || getArg('serverRelativePath') || process.env.SHAREPOINT_SERVER_RELATIVE_PATH || '';

  requireVal('url', dealroomUrl);
  if (!sharepointServerRelativePath) {
    throw new Error('Missing SharePoint destination. Provide --sprel="/sites/<SiteName>/Shared Documents/<FolderPath>".');
  }

  const host = safeHost(dealroomUrl);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const workingDir = path.join('runs', `d2d-${host}-${ts}`);
  await fs.mkdir(workingDir, { recursive: true });

  // Create a dedicated downloads directory within the working directory
  const downloadsPath = path.join(workingDir, 'browser-downloads');
  await fs.mkdir(downloadsPath, { recursive: true });
  console.log('[d2d] configured downloads directory:', downloadsPath);

  // Use a persistent context so we can reliably control the download directory
  const userDataDir = path.join(workingDir, 'user-data');
  await fs.mkdir(userDataDir, { recursive: true });
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    acceptDownloads: true,
    downloadsPath: downloadsPath,
    recordHar: { path: path.join(workingDir, 'network.har'), content: 'embed' }
  } as any);
  await ctx.tracing.start({ screenshots: true, snapshots: true, sources: false });
  const page = await ctx.newPage();

  try {
    console.log('[d2d] navigating to deal room:', dealroomUrl);
    const job = { task_name: `d2d-${host}-${Date.now()}` } as any;
    const downloadedRoot = await handleUniversalDealroom(page, { job, workingDir, urls: [dealroomUrl], downloadsPath });
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

    console.log('[d2d] uploading to SharePoint via server-relative path');
    const receipts = await uploadFolderToSharePointByPath(downloadedRoot, sharepointServerRelativePath, workingDir);
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
    } else {
      console.log('[d2d] Browser kept open after error. Press Ctrl+C to exit.');
      await new Promise(() => {});
    }
    return;
  }

  try { await ctx.tracing.stop({ path: path.join(workingDir, 'trace.zip') }); } catch {}
  await ctx.close();
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
