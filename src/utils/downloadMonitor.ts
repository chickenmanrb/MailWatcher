import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

export interface DownloadMonitorOptions {
  timeout?: number;
  pollInterval?: number;
  expectedExtensions?: string[];
}

export class DownloadMonitor {
  private watchPath: string;
  private initialFiles: Set<string> = new Set();

  constructor(watchPath: string) {
    this.watchPath = watchPath;
  }

  async initialize() {
    try {
      await fs.mkdir(this.watchPath, { recursive: true });
      const files = await fs.readdir(this.watchPath);
      this.initialFiles = new Set(files);
      logger.debug('DownloadMonitor', `Initialized with ${files.length} existing files in ${this.watchPath}`);
    } catch (error) {
      logger.error('DownloadMonitor', 'Failed to initialize', { error: String(error) });
    }
  }

  async waitForNewDownload(options: DownloadMonitorOptions = {}): Promise<string | null> {
    const {
      timeout = 60000,
      pollInterval = 500,
      expectedExtensions = ['.zip', '.pdf', '.xlsx', '.docx', '.rar', '.7z']
    } = options;

    const startTime = Date.now();
    logger.info('DownloadMonitor', `Waiting for download in ${this.watchPath}`);

    while (Date.now() - startTime < timeout) {
      try {
        const currentFiles = await fs.readdir(this.watchPath);
        
        for (const file of currentFiles) {
          if (!this.initialFiles.has(file)) {
            const filePath = path.join(this.watchPath, file);
            
            // Check if it's a partial download (common patterns)
            if (file.endsWith('.crdownload') || file.endsWith('.part') || file.endsWith('.tmp')) {
              logger.debug('DownloadMonitor', `Partial download detected: ${file}`);
              await this.waitForDownloadComplete(filePath, timeout - (Date.now() - startTime));
              continue;
            }

            // Check if it has an expected extension
            const hasExpectedExt = expectedExtensions.some(ext => file.toLowerCase().endsWith(ext));
            if (hasExpectedExt) {
              // Wait a bit to ensure download is complete
              await this.waitForStableFile(filePath);
              logger.info('DownloadMonitor', `New download detected: ${file}`);
              return filePath;
            }
          }
        }

        // Also check default Downloads folder as fallback
        const userDownloadsPath = path.join(process.env.USERPROFILE || '', 'Downloads');
        if (userDownloadsPath !== this.watchPath) {
          const downloadsFiles = await fs.readdir(userDownloadsPath).catch(() => []);
          const recentFiles = await this.getRecentFiles(userDownloadsPath, downloadsFiles, startTime);
          
          if (recentFiles.length > 0) {
            const sourceFile = recentFiles[0];
            const fileName = path.basename(sourceFile);
            const destFile = path.join(this.watchPath, fileName);
            
            await this.waitForStableFile(sourceFile);
            await fs.copyFile(sourceFile, destFile);
            logger.info('DownloadMonitor', `Copied download from Downloads folder: ${fileName}`);
            return destFile;
          }
        }

      } catch (error) {
        logger.debug('DownloadMonitor', 'Error checking for downloads', { error: String(error) });
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    logger.warn('DownloadMonitor', `Timeout waiting for download after ${timeout}ms`);
    return null;
  }

  private async getRecentFiles(dirPath: string, files: string[], sinceTime: number): Promise<string[]> {
    const recentFiles: string[] = [];
    
    for (const file of files) {
      try {
        const filePath = path.join(dirPath, file);
        const stats = await fs.stat(filePath);
        
        // Check if file was created after we started monitoring
        if (stats.birthtimeMs > sinceTime || stats.mtimeMs > sinceTime) {
          const ext = path.extname(file).toLowerCase();
          if (['.zip', '.pdf', '.xlsx', '.docx', '.rar', '.7z'].includes(ext)) {
            recentFiles.push(filePath);
          }
        }
      } catch {}
    }
    
    return recentFiles;
  }

  private async waitForDownloadComplete(partialPath: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      try {
        // Check if partial file still exists
        await fs.access(partialPath);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch {
        // Partial file is gone, download might be complete
        return;
      }
    }
  }

  private async waitForStableFile(filePath: string, stableTime: number = 2000): Promise<void> {
    let lastSize = -1;
    let stableCount = 0;
    
    while (stableCount < 3) {
      try {
        const stats = await fs.stat(filePath);
        
        if (stats.size === lastSize) {
          stableCount++;
        } else {
          stableCount = 0;
          lastSize = stats.size;
        }
        
        await new Promise(resolve => setTimeout(resolve, stableTime / 3));
      } catch {
        return; // File might have been moved
      }
    }
  }

  async cleanup() {
    // Clean up any temporary files in watch directory
    try {
      const files = await fs.readdir(this.watchPath);
      for (const file of files) {
        if (file.endsWith('.crdownload') || file.endsWith('.part') || file.endsWith('.tmp')) {
          await fs.unlink(path.join(this.watchPath, file)).catch(() => {});
        }
      }
    } catch {}
  }
}