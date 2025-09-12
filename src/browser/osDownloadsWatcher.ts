import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import logger from '../util/logger.js';

export type WatcherOptions = {
  timeoutMs?: number;
  pattern?: RegExp; // e.g., /Offering\s+Memorandum|OM/i
  onMatch?: (fullPath: string) => Promise<void> | void;
};

// Watches the OS Downloads folder for new files and calls onMatch when a file appears.
export async function watchDownloadsFolder({ timeoutMs = 30_000, pattern, onMatch }: WatcherOptions) {
  const downloads = path.join(os.homedir(), 'Downloads');
  if (!fs.existsSync(downloads)) {
    logger.debug('Downloads folder not found at %s', downloads);
    return;
  }

  const start = Date.now();
  const seen = new Set(fs.readdirSync(downloads).map(n => path.join(downloads, n)));
  logger.info('Watching OS downloads folder for new files...');

  return await new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(downloads, async (_event, fname) => {
      if (!fname) return;
      const full = path.join(downloads, fname);
      if (seen.has(full)) return;
      seen.add(full);
      if (pattern && !pattern.test(fname)) return;
      try {
        logger.info('Downloads watcher matched file: %s', full);
        if (onMatch) await onMatch(full);
        watcher.close();
        resolve();
      } catch (e) {
        watcher.close();
        reject(e);
      }
    });

    const timer = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        watcher.close();
        clearInterval(timer);
        reject(new Error('watchDownloadsFolder: timeout'));
      }
    }, 500);
  });
}

