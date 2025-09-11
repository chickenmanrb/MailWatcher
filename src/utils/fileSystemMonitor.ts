import * as fs from 'node:fs/promises';
import * as fssync from 'node:fs';
import * as path from 'node:path';
import os from 'node:os';

type Matcher = RegExp | ((name: string) => boolean);

export interface FileSystemMonitorOptions {
  /** Directory where the browser actually writes downloads (RCM forces this). */
  downloadsDir?: string;
  /** Where we'll move the finished file. */
  stagingDir?: string;
  /** If true, append .zip to files that lack an extension (or look like temp/GUID). */
  forceZipExtension?: boolean;
  /** How long to wait for any new file to appear, ms. */
  appearTimeoutMs?: number; // default 60s
  /** How long to wait for the chosen file to become stable, ms. */
  stableTimeoutMs?: number; // default 120s
  /** Interval for polling file sizes, ms. */
  pollMs?: number; // default 400ms
  /** Milliseconds of consecutive "no change" to consider stable. */
  stableWindowMs?: number; // default 1500ms
  /** Optional filename matcher(s) to prefer a specific file among new ones. */
  matchers?: Matcher[]; // e.g., [/Unlimited Saving II/i, /\.zip$/i]
}

interface FileEntry {
  name: string;
  full: string;
  size: number;
  mtimeMs: number;
  isTemp: boolean;
}

const TEMP_SUFFIXES = ['.crdownload', '.part', '.download', '.tmp'];

function isTempName(name: string): boolean {
  const lower = name.toLowerCase();
  return TEMP_SUFFIXES.some(s => lower.endsWith(s));
}

async function listFiles(dir: string): Promise<FileEntry[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];
    
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      
      try {
        const stats = await fs.stat(fullPath);
        result.push({
          name: entry.name,
          full: fullPath,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          isTemp: isTempName(entry.name),
        });
      } catch {
        // Skip files we can't stat
      }
    }
    
    return result;
  } catch {
    return [];
  }
}

function chooseByMatchers(candidates: FileEntry[], matchers: Matcher[] | undefined): FileEntry | null {
  if (!matchers || matchers.length === 0) return candidates[0] ?? null;
  
  for (const matcher of matchers) {
    const hit = candidates.find(f =>
      matcher instanceof RegExp ? matcher.test(f.name) : matcher(f.name)
    );
    if (hit) return hit;
  }
  
  return candidates[0] ?? null;
}

/**
 * Watches the real Downloads directory for a new file.
 * Works even when Playwright never emits a `download` event.
 */
export class FileSystemMonitor {
  readonly downloadsDir: string;
  readonly stagingDir: string;
  readonly appearTimeoutMs: number;
  readonly stableTimeoutMs: number;
  readonly pollMs: number;
  readonly stableWindowMs: number;
  readonly matchers?: Matcher[];
  readonly forceZipExtension: boolean;

  private baseline: Map<string, FileEntry> = new Map();

  constructor(options: FileSystemMonitorOptions = {}) {
    const home = os.homedir();
    const defaultDownloads = path.join(home, 'Downloads');

    this.downloadsDir = options.downloadsDir ?? process.env.RCM_DOWNLOAD_DIR ?? defaultDownloads;
    this.stagingDir = options.stagingDir ?? process.env.D2D_LOCAL_STAGING ?? path.resolve('./.downloads');
    this.appearTimeoutMs = options.appearTimeoutMs ?? 60_000;
    this.stableTimeoutMs = options.stableTimeoutMs ?? 120_000;
    this.pollMs = options.pollMs ?? 400;
    this.stableWindowMs = options.stableWindowMs ?? 1_500;
    this.matchers = options.matchers;
    this.forceZipExtension = options.forceZipExtension ?? false;
  }

  async initBaseline(): Promise<void> {
    await fs.mkdir(this.downloadsDir, { recursive: true }).catch(() => {});
    await fs.mkdir(this.stagingDir, { recursive: true }).catch(() => {});
    const entries = await listFiles(this.downloadsDir);
    this.baseline = new Map(entries.map(e => [e.name, e]));
    console.log(`[FileSystemMonitor] Baseline established with ${this.baseline.size} existing files in ${this.downloadsDir}`);
  }

  private findNewFiles(entries: FileEntry[]): FileEntry[] {
    return entries.filter(e => !this.baseline.has(e.name));
  }

  async waitForNewFile(): Promise<FileEntry> {
    const startTime = Date.now();
    console.log(`[FileSystemMonitor] Waiting for new file (timeout: ${this.appearTimeoutMs}ms)...`);
    
    while (Date.now() - startTime < this.appearTimeoutMs) {
      const currentFiles = await listFiles(this.downloadsDir);
      const newFiles = this.findNewFiles(currentFiles);
      
      if (newFiles.length > 0) {
        console.log(`[FileSystemMonitor] Found ${newFiles.length} new file(s): ${newFiles.map(f => f.name).join(', ')}`);
        
        // First try to match non-temp files
        const nonTempFiles = newFiles.filter(f => !f.isTemp);
        if (nonTempFiles.length > 0) {
          const chosen = chooseByMatchers(nonTempFiles, this.matchers);
          if (chosen) {
            console.log(`[FileSystemMonitor] Selected non-temp file: ${chosen.name}`);
            return chosen;
          }
        }
        
        // If no non-temp files, accept temp files too
        const chosen = chooseByMatchers(newFiles, this.matchers);
        if (chosen) {
          console.log(`[FileSystemMonitor] Selected file (may be temp): ${chosen.name}`);
          return chosen;
        }
        
        // If matchers didn't match, just return the first new file
        console.log(`[FileSystemMonitor] No matcher matched, returning first new file: ${newFiles[0].name}`);
        return newFiles[0];
      }
      
      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }
    
    throw new Error(`No new download appeared in ${Math.round(this.appearTimeoutMs / 1000)}s (dir: ${this.downloadsDir}).`);
  }

  /**
   * Wait until file stops growing and no temp suffix remains.
   */
  async waitForStability(entry: FileEntry): Promise<FileEntry> {
    const deadline = Date.now() + this.stableTimeoutMs;
    let lastSize = -1;
    let stableSince = 0;
    let currentEntry = entry;

    console.log(`[FileSystemMonitor] Waiting for file stability: ${entry.name}`);

    while (Date.now() < deadline) {
      // Check if file still exists
      const exists = fssync.existsSync(currentEntry.full);
      
      if (!exists) {
        // File might have been renamed (temp -> final)
        const currentFiles = await listFiles(this.downloadsDir);
        const baseName = path.parse(currentEntry.name).name;
        
        // Look for non-temp file with same base name
        const renamedFile = currentFiles.find(f => 
          path.parse(f.name).name === baseName && !f.isTemp
        );
        
        if (renamedFile) {
          console.log(`[FileSystemMonitor] File renamed: ${currentEntry.name} -> ${renamedFile.name}`);
          currentEntry = renamedFile;
        } else {
          // File disappeared, wait a bit
          await new Promise(resolve => setTimeout(resolve, this.pollMs));
          continue;
        }
      }

      try {
        const stats = await fs.stat(currentEntry.full);
        const isTemp = isTempName(currentEntry.name);
        const currentSize = stats.size;

        // For temp files, just check size stability
        // For non-temp files, check size stability
        if (currentSize === lastSize && currentSize > 0) {
          stableSince += this.pollMs;
          if (stableSince >= this.stableWindowMs) {
            console.log(`[FileSystemMonitor] File stable: ${currentEntry.name} (${currentSize} bytes, temp=${isTemp})`);
            return { ...currentEntry, size: currentSize, isTemp };
          }
        } else {
          stableSince = 0;
        }
        
        lastSize = currentSize;
      } catch {
        // Error reading file, reset stability counter
        stableSince = 0;
      }

      await new Promise(resolve => setTimeout(resolve, this.pollMs));
    }

    throw new Error(`Download never stabilized within ${Math.round(this.stableTimeoutMs / 1000)}s: ${currentEntry.name}`);
  }

  async moveToStaging(entry: FileEntry): Promise<string> {
    // Remove temp suffixes if present
    let finalName = entry.name.replace(/(\.crdownload|\.part|\.download|\.tmp)$/i, '');

    // If requested, ensure .zip extension when missing or when the file looks like a GUID-name
    if (this.forceZipExtension) {
      const hasExt = /\.[a-z0-9]{2,6}$/i.test(finalName);
      const looksGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.parse(finalName).name);
      if (!hasExt || looksGuid) {
        if (!finalName.toLowerCase().endsWith('.zip')) finalName += '.zip';
        console.log(`[FileSystemMonitor] Appending .zip extension to finalized file name -> ${finalName}`);
      }
    }

    const destPath = path.join(this.stagingDir, finalName || entry.name);
    
    console.log(`[FileSystemMonitor] Moving file to staging: ${entry.full} -> ${destPath}`);
    
    await fs.copyFile(entry.full, destPath);
    
    // Verify the copy
    const destStats = await fs.stat(destPath);
    if (destStats.size === 0) {
      throw new Error(`Failed to copy file - destination is empty: ${destPath}`);
    }
    
    // Optionally delete the original (commented out for safety)
    // await fs.unlink(entry.full).catch(() => {});
    
    return destPath;
  }

  /**
   * Complete workflow: wait for new file, wait for stability, move to staging
   */
  async captureDownload(): Promise<string> {
    const newFile = await this.waitForNewFile();
    const stableFile = await this.waitForStability(newFile);
    const stagedPath = await this.moveToStaging(stableFile);
    return stagedPath;
  }
}
