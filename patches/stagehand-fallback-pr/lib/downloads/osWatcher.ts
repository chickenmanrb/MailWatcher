import fs from "fs";
import path from "path";
import os from "os";

export type WatcherOptions = {
  timeoutMs?: number;
  pattern?: RegExp; // e.g., /Offering\s+Memorandum|OM/i
  onMatch?: (fullPath: string) => Promise<void> | void;
};

// Watches the OS Downloads folder for new files and calls onMatch when a file appears.
export async function watchDownloadsFolder({ timeoutMs = 30000, pattern, onMatch }: WatcherOptions) {
  const downloads = path.join(os.homedir(), "Downloads");
  if (!fs.existsSync(downloads)) return;

  const start = Date.now();
  const seen = new Set(fs.readdirSync(downloads).map(n => path.join(downloads, n)));

  return await new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(downloads, async (_event, fname) => {
      if (!fname) return;
      const full = path.join(downloads, fname);
      if (seen.has(full)) return;
      seen.add(full);
      if (pattern && !pattern.test(fname)) return;
      try {
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
        reject(new Error("watchDownloadsFolder: timeout"));
      }
    }, 500);
  });
}
