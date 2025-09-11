import { Browser, BrowserContext, type BrowserContextOptions } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function createBrowserContext(browser: Browser, domainKey: string, options: Partial<BrowserContextOptions> = {}): Promise<BrowserContext> {
  const stateDir = process.env.STATE_DIR ?? '.auth';
  await fs.mkdir(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, `${domainKey}.json`);

  // Create a dedicated downloads directory if not specified
  const downloadsPath = options.downloadsPath || path.join(process.cwd(), 'runs', 'downloads-temp', domainKey);
  await fs.mkdir(downloadsPath, { recursive: true });

  const ctx = await browser.newContext({
    storageState: (await fileExists(stateFile)) ? stateFile : undefined,
    acceptDownloads: true,
    downloadsPath,
    ...options
  });

  // Save state on close to persist SSO/cookies/MFA (if allowed)
  const origClose = ctx.close.bind(ctx);
  (ctx as any).close = async () => {
    try {
      await ctx.storageState({ path: stateFile });
    } catch { /* ignore */ }
    await origClose();
  };
  return ctx;
}

async function fileExists(p: string) {
  try { await fs.stat(p); return true; } catch { return false; }
}

