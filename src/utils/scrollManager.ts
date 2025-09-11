import type { Page, ElementHandle } from 'playwright';
import { logger } from './logger.js';

export interface ScrollOptions {
  behavior?: 'auto' | 'smooth';
  block?: 'start' | 'center' | 'end' | 'nearest';
  inline?: 'start' | 'center' | 'end' | 'nearest';
  offsetTop?: number;
  offsetBottom?: number;
}

const DEFAULT_SCROLL_OPTIONS: ScrollOptions = {
  behavior: 'smooth',
  block: 'center',
  inline: 'nearest',
  offsetTop: 100,
  offsetBottom: 100,
};

export class ScrollManager {
  static async scrollIntoView(
    page: Page,
    selector: string,
    options: ScrollOptions = {}
  ): Promise<boolean> {
    const opts = { ...DEFAULT_SCROLL_OPTIONS, ...options };
    
    try {
      const element = await page.$(selector);
      if (!element) {
        logger.warn('ScrollManager', `Element not found for scrolling: ${selector}`);
        return false;
      }

      return await this.scrollElementIntoView(page, element, opts);
    } catch (error) {
      logger.error('ScrollManager', `Failed to scroll to element: ${selector}`, { error: String(error) });
      return false;
    }
  }

  static async scrollElementIntoView(
    page: Page,
    element: ElementHandle,
    options: ScrollOptions = {}
  ): Promise<boolean> {
    const opts = { ...DEFAULT_SCROLL_OPTIONS, ...options };
    
    try {
      const isVisible = await element.isVisible();
      if (!isVisible) {
        logger.debug('ScrollManager', 'Element is not visible, attempting to scroll parent');
        
        await page.evaluate((el: any) => {
          let parent = (el as HTMLElement).parentElement as HTMLElement | null;
          while (parent) {
            if (parent.scrollHeight > parent.clientHeight) {
              parent.scrollTop = (el as HTMLElement).offsetTop - parent.offsetTop;
              break;
            }
            parent = parent.parentElement as HTMLElement | null;
          }
        }, element);
      }

      const viewportData = await page.evaluate(({ el, opts }: any) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const viewport = {
          width: window.innerWidth,
          height: window.innerHeight,
        };

        const stickyElements = Array.from(document.querySelectorAll('*')).filter(elem => {
          const style = window.getComputedStyle(elem);
          return style.position === 'fixed' || style.position === 'sticky';
        });

        let headerHeight = 0;
        let footerHeight = 0;

        stickyElements.forEach(elem => {
          const rect = elem.getBoundingClientRect();
          if (rect.top <= 100) {
            headerHeight = Math.max(headerHeight, rect.bottom);
          }
          if (rect.bottom >= viewport.height - 100) {
            footerHeight = Math.max(footerHeight, viewport.height - rect.top);
          }
        });

        const effectiveViewport = {
          top: headerHeight + (opts.offsetTop || 0),
          bottom: viewport.height - footerHeight - (opts.offsetBottom || 0),
          left: 0,
          right: viewport.width,
        };

        const isInView = 
          rect.top >= effectiveViewport.top &&
          rect.bottom <= effectiveViewport.bottom &&
          rect.left >= effectiveViewport.left &&
          rect.right <= effectiveViewport.right;

        return {
          rect,
          viewport,
          effectiveViewport,
          isInView,
          headerHeight,
          footerHeight,
        };
      }, { el: element, opts });

      if (viewportData.isInView) {
        logger.debug('ScrollManager', 'Element already in view');
        return true;
      }

      await element.scrollIntoViewIfNeeded();

      if (opts.behavior === 'smooth') {
        await page.waitForTimeout(500);
      }

      await page.evaluate(({ el, opts }: any) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const targetY = rect.top + window.scrollY;
        const offsetY = window.innerHeight / 2 - rect.height / 2;
        
        window.scrollTo({
          top: targetY - offsetY,
          behavior: opts.behavior || 'auto',
        });
      }, { el: element, opts });

      if (opts.behavior === 'smooth') {
        await page.waitForTimeout(300);
      }

      logger.debug('ScrollManager', 'Element scrolled into view');
      return true;
    } catch (error) {
      logger.error('ScrollManager', 'Failed to scroll element into view', { error: String(error) });
      return false;
    }
  }

  static async ensureElementClickable(
    page: Page,
    selector: string,
    options: ScrollOptions = {}
  ): Promise<boolean> {
    try {
      const element = await page.$(selector);
      if (!element) return false;

      await this.scrollElementIntoView(page, element, options);

      const isClickable = await page.evaluate((el: any) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const topElement = document.elementFromPoint(x, y);
        
        return el === topElement || (el as HTMLElement).contains(topElement);
      }, element);

      if (!isClickable) {
        logger.warn('ScrollManager', 'Element is not clickable, might be covered by another element');
        
        await page.evaluate((el: any) => {
          const allElements = document.querySelectorAll('*');
          allElements.forEach(elem => {
            const style = window.getComputedStyle(elem);
            if (style.position === 'fixed' || style.position === 'sticky') {
              const rect = elem.getBoundingClientRect();
              const elRect = (el as HTMLElement).getBoundingClientRect();
              
              if (rect.bottom > elRect.top && rect.top < elRect.bottom) {
                (elem as HTMLElement).style.pointerEvents = 'none';
              }
            }
          });
        }, element);
      }

      return true;
    } catch (error) {
      logger.error('ScrollManager', `Failed to ensure element clickable: ${selector}`, { error: String(error) });
      return false;
    }
  }

  static async scrollToTop(page: Page, smooth: boolean = true): Promise<void> {
    await page.evaluate((smooth) => {
      window.scrollTo({
        top: 0,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }, smooth);
    
    if (smooth) {
      await page.waitForTimeout(500);
    }
  }

  static async scrollToBottom(page: Page, smooth: boolean = true): Promise<void> {
    await page.evaluate((smooth) => {
      window.scrollTo({
        top: document.body.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }, smooth);
    
    if (smooth) {
      await page.waitForTimeout(500);
    }
  }

  static async getScrollPosition(page: Page): Promise<{ x: number; y: number }> {
    return await page.evaluate(() => ({
      x: window.scrollX,
      y: window.scrollY,
    }));
  }
}
