import type { Page, Frame } from 'playwright';
import { logger } from './logger.js';

export interface WaitOptions {
  timeout?: number;
  checkInterval?: number;
}

const DEFAULT_WAIT_OPTIONS: Required<WaitOptions> = {
  timeout: 30000,
  checkInterval: 100,
};

export class WaitStrategies {
  static async waitForFormStability(
    page: Page,
    options: WaitOptions = {}
  ): Promise<void> {
    const opts = { ...DEFAULT_WAIT_OPTIONS, ...options };
    const endTime = Date.now() + opts.timeout;
    let lastMutationTime = Date.now();
    let stable = false;

    const done = logger.time('WaitStrategies', 'waitForFormStability');

    await page.evaluate(() => {
      (window as any).__formMutationCount = 0;
      const observer = new MutationObserver(() => {
        (window as any).__formMutationCount++;
        (window as any).__lastMutationTime = Date.now();
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled', 'readonly', 'hidden', 'style'],
      });
      (window as any).__formObserver = observer;
    });

    while (Date.now() < endTime && !stable) {
      await page.waitForTimeout(opts.checkInterval);
      
      const mutationData = await page.evaluate(() => ({
        count: (window as any).__formMutationCount || 0,
        lastTime: (window as any).__lastMutationTime || 0,
      }));

      if (mutationData.count === 0 || Date.now() - mutationData.lastTime > 500) {
        stable = true;
      }

      await page.evaluate(() => {
        (window as any).__formMutationCount = 0;
      });
    }

    await page.evaluate(() => {
      if ((window as any).__formObserver) {
        (window as any).__formObserver.disconnect();
        delete (window as any).__formObserver;
      }
    });

    done();
    logger.debug('WaitStrategies', `Form stability achieved: ${stable}`);
  }

  static async waitForNoSpinners(
    page: Page,
    options: WaitOptions = {}
  ): Promise<void> {
    const opts = { ...DEFAULT_WAIT_OPTIONS, ...options };
    const done = logger.time('WaitStrategies', 'waitForNoSpinners');

    const spinnerSelectors = [
      '.spinner',
      '.loader',
      '.loading',
      '[class*="spinner"]',
      '[class*="loader"]',
      '[class*="loading"]',
      '[role="progressbar"]',
      'svg[class*="spin"]',
      'div[class*="spin"]',
    ];

    try {
      await Promise.race([
        page.waitForTimeout(opts.timeout),
        (async () => {
          for (const selector of spinnerSelectors) {
            try {
              await page.waitForSelector(selector, { state: 'hidden', timeout: 1000 });
            } catch {
              // Selector not found or already hidden
            }
          }
        })(),
      ]);
    } finally {
      done();
    }
  }

  static async waitForNetworkSettled(
    page: Page,
    options: WaitOptions & { maxInflightRequests?: number } = {}
  ): Promise<void> {
    const opts = { 
      ...DEFAULT_WAIT_OPTIONS, 
      maxInflightRequests: 2,
      ...options 
    };
    
    const done = logger.time('WaitStrategies', 'waitForNetworkSettled');
    let inflightRequests = 0;
    let settledTime = 0;
    const requiredSettleTime = 500;

    const onRequest = () => inflightRequests++;
    const onResponse = () => {
      inflightRequests--;
      if (inflightRequests <= opts.maxInflightRequests) {
        settledTime = Date.now();
      }
    };

    page.on('request', onRequest);
    page.on('response', onResponse);
    page.on('requestfailed', onResponse);

    const endTime = Date.now() + opts.timeout;
    
    try {
      while (Date.now() < endTime) {
        if (inflightRequests <= opts.maxInflightRequests && 
            Date.now() - settledTime >= requiredSettleTime) {
          break;
        }
        await page.waitForTimeout(opts.checkInterval);
      }
    } finally {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onResponse);
      done();
    }

    logger.debug('WaitStrategies', `Network settled with ${inflightRequests} requests in flight`);
  }

  static async waitForElement(
    page: Page,
    selector: string,
    options: WaitOptions & { state?: 'attached' | 'detached' | 'visible' | 'hidden' } = {}
  ): Promise<boolean> {
    const opts = { 
      ...DEFAULT_WAIT_OPTIONS,
      state: 'visible' as const,
      ...options 
    };

    try {
      await page.waitForSelector(selector, {
        state: opts.state,
        timeout: opts.timeout,
      });
      logger.debug('WaitStrategies', `Element found: ${selector}`);
      return true;
    } catch {
      logger.debug('WaitStrategies', `Element not found within timeout: ${selector}`);
      return false;
    }
  }

  static async waitForAnyElement(
    page: Page,
    selectors: string[],
    options: WaitOptions = {}
  ): Promise<string | null> {
    const opts = { ...DEFAULT_WAIT_OPTIONS, ...options };
    const done = logger.time('WaitStrategies', 'waitForAnyElement');

    try {
      const result = await Promise.race([
        ...selectors.map(async (selector) => {
          try {
            await page.waitForSelector(selector, { 
              state: 'visible', 
              timeout: opts.timeout 
            });
            return selector;
          } catch {
            return null;
          }
        }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), opts.timeout)),
      ]);

      if (result) {
        logger.debug('WaitStrategies', `Found element: ${result}`);
      }
      return result;
    } finally {
      done();
    }
  }

  static async waitForFrameReady(frame: Frame, options: WaitOptions = {}): Promise<void> {
    const opts = { ...DEFAULT_WAIT_OPTIONS, ...options };
    const done = logger.time('WaitStrategies', 'waitForFrameReady');

    try {
      await frame.waitForLoadState('domcontentloaded', { timeout: opts.timeout });
      
      const hasContent = await frame.evaluate(() => {
        return document.body && document.body.children.length > 0;
      });

      if (!hasContent) {
        await frame.waitForTimeout(500);
      }
    } catch (error) {
      logger.warn('WaitStrategies', 'Frame not ready within timeout', { error: String(error) });
    } finally {
      done();
    }
  }
}