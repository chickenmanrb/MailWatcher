import type { Page, Download } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { logger } from '../utils/logger.js';
import { downloadRetry } from '../utils/retry.js';
import { WaitStrategies } from '../utils/waitStrategies.js';
import { ScrollManager } from '../utils/scrollManager.js';
import type { FieldSelector, PlatformConfig } from '../config/platformSelectors.js';
import { clickDownloadAll, enumerateFileLinks } from '../browser/download.js';

export interface DownloadStrategy {
  name: string;
  priority: number;
  execute: (page: Page, outputDir: string, config?: DownloadConfig) => Promise<string | null>;
}

export interface DownloadConfig {
  platformConfig?: PlatformConfig;
  timeout?: number;
  confirmationSelectors?: string[];
  selectAllFirst?: boolean;
  waitForStability?: boolean;
}

export class DownloadStrategyManager {
  private strategies: DownloadStrategy[] = [];
  private metrics = {
    strategiesAttempted: 0,
    strategiesSucceeded: 0,
    filesDownloaded: 0,
    totalBytes: 0,
    downloadTime: 0,
  };

  constructor() {
    this.initializeStrategies();
  }

  private initializeStrategies() {
    this.strategies = [
      {
        name: 'platform-specific-download',
        priority: 10,
        execute: this.platformSpecificDownload.bind(this),
      },
      {
        name: 'download-selected-with-size',
        priority: 9,
        execute: this.downloadSelectedWithSize.bind(this),
      },
      {
        name: 'download-all-button',
        priority: 8,
        execute: this.downloadAllButton.bind(this),
      },
      {
        name: 'grid-select-and-download',
        priority: 7,
        execute: this.gridSelectAndDownload.bind(this),
      },
      {
        name: 'enumerate-file-links',
        priority: 5,
        execute: this.enumerateAndDownload.bind(this),
      },
      {
        name: 'context-menu-download',
        priority: 4,
        execute: this.contextMenuDownload.bind(this),
      },
      {
        name: 'iframe-download-search',
        priority: 3,
        execute: this.iframeDownloadSearch.bind(this),
      },
    ];

    this.strategies.sort((a, b) => b.priority - a.priority);
  }

  async executeStrategies(
    page: Page,
    outputDir: string,
    config: DownloadConfig = {}
  ): Promise<string | null> {
    const timer = logger.time('DownloadStrategyManager', 'executeStrategies');
    
    try {
      await fs.mkdir(outputDir, { recursive: true });

      if (config.waitForStability) {
        await WaitStrategies.waitForFormStability(page, { timeout: 5000 });
        await WaitStrategies.waitForNoSpinners(page, { timeout: 5000 });
      }

      if (config.selectAllFirst) {
        await this.selectAllDocuments(page, config);
      }

      for (const strategy of this.strategies) {
        logger.info('DownloadStrategyManager', `Attempting strategy: ${strategy.name}`);
        this.metrics.strategiesAttempted++;

        try {
          const result = await downloadRetry.execute(
            () => strategy.execute(page, outputDir, config),
            strategy.name
          );

          if (result) {
            this.metrics.strategiesSucceeded++;
            logger.info('DownloadStrategyManager', `Strategy succeeded: ${strategy.name}`, { result });
            return result;
          }
        } catch (error) {
          logger.debug('DownloadStrategyManager', `Strategy failed: ${strategy.name}`, { error: String(error) });
        }
      }

      logger.warn('DownloadStrategyManager', 'All download strategies failed');
      return null;
    } finally {
      timer();
      logger.info('DownloadStrategyManager', 'Download metrics', this.metrics);
    }
  }

  private async platformSpecificDownload(
    page: Page,
    outputDir: string,
    config: DownloadConfig = {}
  ): Promise<string | null> {
    if (!config.platformConfig?.download) return null;

    const downloadConfig = config.platformConfig.download;
    
    if (downloadConfig.selectAll) {
      for (const selector of downloadConfig.selectAll) {
        await this.applySelector(page, selector, 'check');
      }
      await page.waitForTimeout(500);
    }

    if (downloadConfig.downloadButton) {
      for (const selector of downloadConfig.downloadButton) {
        const result = await this.downloadWithSelector(page, selector, outputDir, config);
        if (result) return result;
      }
    }

    if (downloadConfig.downloadAll) {
      for (const selector of downloadConfig.downloadAll) {
        const result = await this.downloadWithSelector(page, selector, outputDir, config);
        if (result) return result;
      }
    }

    return null;
  }

  private async downloadSelectedWithSize(
    page: Page,
    outputDir: string,
    config: DownloadConfig = {}
  ): Promise<string | null> {
    await page.waitForTimeout(800);

    const downloadPromise = page.waitForEvent('download', { timeout: config.timeout || 60000 }).catch(() => null);
    
    const selectors = [
      page.getByRole('button', { name: /download\s*\((?!0\s*kb)[^)]+\)/i }),
      page.locator('button.vdr-download-button:not([disabled])'),
      page.locator('button:has-text("Download"):not([disabled])'),
    ];

    let clicked = false;
    for (const locator of selectors) {
      try {
        if (await locator.count() > 0) {
          const element = locator.first();
          if (!(await element.isDisabled().catch(() => false))) {
            await element.click({ timeout: 2000 });
            clicked = true;
            logger.debug('DownloadStrategyManager', 'Clicked download button with size');
            break;
          }
        }
      } catch {}
    }

    if (!clicked) return null;

    await this.handleConfirmationDialog(page, config);

    const download = await downloadPromise;
    if (!download) return null;

    return await this.saveDownload(download, outputDir);
  }

  private async downloadAllButton(
    page: Page,
    outputDir: string,
    config: DownloadConfig = {}
  ): Promise<string | null> {
    const selectors = [
      'button:has-text("Download All")',
      'a:has-text("Download All")',
      'button[title*="Download All"]',
      '[aria-label*="Download All"]',
      'button:has-text("Export All")',
      'a:has-text("Export All")',
    ];

    const archive = await clickDownloadAll(page, selectors, outputDir).catch(() => null);
    if (archive) {
      this.metrics.filesDownloaded++;
      return archive;
    }

    return null;
  }

  private async gridSelectAndDownload(
    page: Page,
    outputDir: string,
    config: DownloadConfig = {}
  ): Promise<string | null> {
    const selectSelectors = [
      page.getByRole('checkbox', { name: 'Select All Rows' }),
      page.locator('thead input[type="checkbox"]'),
      page.locator('th input[type="checkbox"]'),
      page.locator('input[kendogridselectallcheckbox]'),
    ];

    for (const locator of selectSelectors) {
      try {
        if (await locator.count() > 0) {
          await locator.first().check({ force: true });
          await page.waitForTimeout(500);
          logger.debug('DownloadStrategyManager', 'Selected all grid rows');
          break;
        }
      } catch {}
    }

    return await this.downloadSelectedWithSize(page, outputDir, config);
  }

  private async enumerateAndDownload(
    page: Page,
    outputDir: string,
    config: DownloadConfig = {}
  ): Promise<string | null> {
    const selectors = [
      'a[href*="download"]',
      'a:has-text("Download")',
      'a[href$=".pdf"]',
      'a[href$=".zip"]',
      'a[href$=".xlsx"]',
      'a[href$=".docx"]',
      'button[onclick*="download"]',
      '[data-action="download"]',
    ];

    const downloaded = await enumerateFileLinks(page, selectors, outputDir).catch(() => []);
    
    if (downloaded.length > 0) {
      this.metrics.filesDownloaded += downloaded.length;
      logger.info('DownloadStrategyManager', `Downloaded ${downloaded.length} files via enumeration`);
      return outputDir;
    }

    return null;
  }

  private async contextMenuDownload(
    page: Page,
    outputDir: string,
    config: DownloadConfig = {}
  ): Promise<string | null> {
    const fileElements = await page.$$('[role="row"], tr[data-file], .file-item, .document-item');
    
    for (const element of fileElements.slice(0, 5)) {
      try {
        await element.click({ button: 'right' });
        await page.waitForTimeout(300);

        const contextMenu = await page.$('[role="menu"], .context-menu, .dropdown-menu:visible');
        if (contextMenu) {
          const downloadOption = await contextMenu.$('text=/download/i');
          if (downloadOption) {
            const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
            await downloadOption.click();
            
            const download = await downloadPromise;
            if (download) {
              const saved = await this.saveDownload(download, outputDir);
              if (saved) return saved;
            }
          }
        }

        await page.keyboard.press('Escape');
      } catch {}
    }

    return null;
  }

  private async iframeDownloadSearch(
    page: Page,
    outputDir: string,
    config: DownloadConfig = {}
  ): Promise<string | null> {
    const frames = page.frames();
    
    for (const frame of frames) {
      if (frame === page.mainFrame()) continue;

      try {
        const downloadButtons = await frame.$$('button:has-text("Download"), a:has-text("Download")');
        
        for (const button of downloadButtons) {
          const downloadPromise = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
          await button.click();
          
          const download = await downloadPromise;
          if (download) {
            const saved = await this.saveDownload(download, outputDir);
            if (saved) return saved;
          }
        }
      } catch {}
    }

    return null;
  }

  private async selectAllDocuments(page: Page, config: DownloadConfig = {}): Promise<void> {
    const selectors = config.platformConfig?.download?.selectAll || [
      { selector: 'input[type="checkbox"][aria-label*="Select all"]' },
      { selector: 'thead input[type="checkbox"]' },
      { selector: 'th input[type="checkbox"]' },
    ];

    for (const selector of selectors) {
      await this.applySelector(page, selector, 'check');
    }
  }

  private async applySelector(
    page: Page,
    selector: FieldSelector,
    action: 'check' | 'click'
  ): Promise<boolean> {
    let element;

    if (selector.selector) {
      element = await page.$(selector.selector);
    } else if (selector.xpath) {
      element = await page.$(`xpath=${selector.xpath}`);
    } else if (selector.text) {
      element = await page.$(`text=${selector.text}`);
    }

    if (!element) return false;

    try {
      if (selector.scrollIntoView) {
        await ScrollManager.scrollElementIntoView(page, element);
      }

      if (selector.waitBefore) {
        await page.waitForTimeout(selector.waitBefore);
      }

      if (action === 'check') {
        await element.check({ force: selector.force });
      } else {
        await element.click({ force: selector.force });
      }

      return true;
    } catch {
      return false;
    }
  }

  private async downloadWithSelector(
    page: Page,
    selector: FieldSelector,
    outputDir: string,
    config: DownloadConfig
  ): Promise<string | null> {
    const downloadPromise = page.waitForEvent('download', { timeout: config.timeout || 60000 }).catch(() => null);
    
    const clicked = await this.applySelector(page, selector, 'click');
    if (!clicked) return null;

    await this.handleConfirmationDialog(page, config);

    const download = await downloadPromise;
    if (!download) return null;

    return await this.saveDownload(download, outputDir);
  }

  private async handleConfirmationDialog(page: Page, config: DownloadConfig): Promise<void> {
    await page.waitForTimeout(600);

    const confirmationSelectors = config.confirmationSelectors || [
      'button:has-text("OK")',
      'button:has-text("Yes")',
      'button:has-text("Confirm")',
      'button:has-text("Download")',
      'button:has-text("Start")',
      'button:has-text("Proceed")',
      '[role="dialog"] button:has-text("OK")',
      '[role="dialog"] button:has-text("Yes")',
      '.modal button:has-text("OK")',
    ];

    if (config.platformConfig?.download?.confirmDialog) {
      for (const selector of config.platformConfig.download.confirmDialog) {
        await this.applySelector(page, selector, 'click');
      }
    }

    for (const selector of confirmationSelectors) {
      try {
        const button = await page.$(selector);
        if (button && await button.isVisible()) {
          await button.click();
          await page.waitForTimeout(500);
          break;
        }
      } catch {}
    }
  }

  private async saveDownload(download: Download, outputDir: string): Promise<string> {
    const startTime = Date.now();
    const suggestedFilename = download.suggestedFilename() || 'download.zip';
    const filePath = path.join(outputDir, suggestedFilename);

    try {
      await download.saveAs(filePath);
      
      const stats = await fs.stat(filePath);
      this.metrics.filesDownloaded++;
      this.metrics.totalBytes += stats.size;
      this.metrics.downloadTime += Date.now() - startTime;

      logger.info('DownloadStrategyManager', `Downloaded: ${suggestedFilename}`, {
        size: stats.size,
        time: Date.now() - startTime,
      });

      return filePath;
    } catch (error) {
      logger.error('DownloadStrategyManager', 'Failed to save download', { error: String(error) });
      throw error;
    }
  }

  addStrategy(strategy: DownloadStrategy) {
    this.strategies.push(strategy);
    this.strategies.sort((a, b) => b.priority - a.priority);
  }

  getMetrics() {
    return {
      ...this.metrics,
      avgDownloadTime: this.metrics.filesDownloaded > 0 
        ? Math.round(this.metrics.downloadTime / this.metrics.filesDownloaded)
        : 0,
    };
  }

  reset() {
    this.metrics = {
      strategiesAttempted: 0,
      strategiesSucceeded: 0,
      filesDownloaded: 0,
      totalBytes: 0,
      downloadTime: 0,
    };
  }
}
