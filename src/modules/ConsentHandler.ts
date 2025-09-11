import type { Page, Frame } from 'playwright';
import { logger } from '../utils/logger.js';
import { FuzzyMatcher } from '../matchers/fuzzyMatcher.js';
import { ScrollManager } from '../utils/scrollManager.js';
import type { FieldSelector, PlatformConfig } from '../config/platformSelectors.js';

export interface ConsentOptions {
  aggressive?: boolean;
  optInMarketing?: boolean;
  multiLanguage?: boolean;
  customPatterns?: RegExp[];
  platformConfig?: PlatformConfig;
}

interface ConsentPattern {
  pattern: RegExp;
  priority: number;
  type: 'checkbox' | 'radio' | 'button';
  action: 'check' | 'click' | 'select';
}

export class ConsentHandler {
  private patterns: ConsentPattern[] = [];
  private metrics = {
    checkboxesChecked: 0,
    radioButtonsSelected: 0,
    buttonsClicked: 0,
    totalConsents: 0,
  };

  constructor() {
    this.initializePatterns();
  }

  private initializePatterns() {
    this.patterns = [
      {
        pattern: /(i\s*agree|accept.*terms|accept.*conditions|agree.*terms|agree.*conditions)/i,
        priority: 10,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(confidential|nda|non[-\s]?disclosure|privacy|data\s*protection)/i,
        priority: 9,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(terms.*service|terms.*use|terms.*conditions|legal.*terms)/i,
        priority: 8,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(consent|authorize|permission|allow|permit)/i,
        priority: 7,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(acknowledge|confirm|understand|read.*understand)/i,
        priority: 6,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(newsletter|marketing|promotional|updates|communications)/i,
        priority: 3,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(yes.*agree|no.*disagree)/i,
        priority: 8,
        type: 'radio',
        action: 'select',
      },
      {
        pattern: /(i\s*agree|accept|continue|proceed|confirm)/i,
        priority: 9,
        type: 'button',
        action: 'click',
      },
    ];

    if (process.env.CONSENT_MULTI_LANGUAGE === 'true') {
      this.addMultiLanguagePatterns();
    }
  }

  private addMultiLanguagePatterns() {
    const multiLangPatterns: ConsentPattern[] = [
      {
        pattern: /(j'accepte|accepter|d'accord)/i,
        priority: 8,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(acepto|aceptar|de\s*acuerdo)/i,
        priority: 8,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(ich\s*stimme\s*zu|akzeptieren|einverstanden)/i,
        priority: 8,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(accetto|accettare|d'accordo)/i,
        priority: 8,
        type: 'checkbox',
        action: 'check',
      },
      {
        pattern: /(同意|接受|确认)/,
        priority: 8,
        type: 'checkbox',
        action: 'check',
      },
    ];
    
    this.patterns.push(...multiLangPatterns);
  }

  async handlePageConsent(page: Page, options: ConsentOptions = {}): Promise<void> {
    const timer = logger.time('ConsentHandler', 'handlePageConsent');
    
    try {
      if (options.platformConfig?.consent) {
        await this.applyPlatformConsent(page, options.platformConfig.consent, options);
      }

      for (const frame of page.frames()) {
        await this.handleFrameConsent(frame, options);
      }

      await this.clickConsentButtons(page, options);
      
      logger.info('ConsentHandler', 'Consent handling completed', this.metrics);
    } finally {
      timer();
    }
  }

  private async applyPlatformConsent(
    page: Page,
    consentConfig: PlatformConfig['consent'],
    options: ConsentOptions
  ): Promise<void> {
    if (consentConfig?.checkboxes) {
      for (const selector of consentConfig.checkboxes) {
        await this.applySelector(page, selector, 'check');
      }
    }

    if (consentConfig?.radioButtons) {
      for (const selector of consentConfig.radioButtons) {
        await this.applySelector(page, selector, 'select');
      }
    }

    if (consentConfig?.buttons) {
      for (const selector of consentConfig.buttons) {
        await this.applySelector(page, selector, 'click');
      }
    }
  }

  private async applySelector(
    page: Page,
    selector: FieldSelector,
    action: 'check' | 'select' | 'click'
  ): Promise<void> {
    let element;

    if (selector.selector) {
      element = await page.$(selector.selector);
    } else if (selector.xpath) {
      element = await page.$(`xpath=${selector.xpath}`);
    } else if (selector.text) {
      element = await page.$(`text=${selector.text}`);
    }

    if (!element) return;

    try {
      if (selector.scrollIntoView) {
        await ScrollManager.scrollElementIntoView(page, element);
      }

      if (selector.waitBefore) {
        await page.waitForTimeout(selector.waitBefore);
      }

      switch (action) {
        case 'check':
          await element.check({ force: selector.force });
          this.metrics.checkboxesChecked++;
          break;
        case 'select':
          await element.click({ force: selector.force });
          this.metrics.radioButtonsSelected++;
          break;
        case 'click':
          await element.click({ force: selector.force });
          this.metrics.buttonsClicked++;
          break;
      }
      
      this.metrics.totalConsents++;
    } catch (error) {
      logger.debug('ConsentHandler', `Failed to apply selector action: ${action}`, { error: String(error) });
    }
  }

  private async handleFrameConsent(frame: Frame, options: ConsentOptions): Promise<void> {
    const patterns = this.getActivePatterns(options);
    
    const result = await frame.evaluate(
      ({ patterns, options }) => {
        const metrics = {
          checkboxes: 0,
          radios: 0,
          buttons: 0,
        };

        function getElementText(element: HTMLElement): string {
          const text = [
            element.textContent || '',
            element.getAttribute('aria-label') || '',
            element.getAttribute('title') || '',
            element.getAttribute('placeholder') || '',
          ];

          const id = element.id;
          if (id) {
            const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (label) text.push(label.textContent || '');
          }

          const closestLabel = element.closest('label');
          if (closestLabel) text.push(closestLabel.textContent || '');

          const parent = element.parentElement;
          if (parent) text.push(parent.textContent || '');

          return text.join(' ').toLowerCase();
        }

        function matchesPattern(text: string, patternStr: string): boolean {
          try {
            return new RegExp(patternStr, 'i').test(text);
          } catch {
            return false;
          }
        }

        const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
        for (const checkbox of checkboxes) {
          const text = getElementText(checkbox as HTMLElement);
          
          for (const pattern of patterns.filter((p: any) => p.type === 'checkbox')) {
            if (matchesPattern(text, pattern.pattern)) {
              if ((checkbox as HTMLInputElement).type === 'checkbox') {
                const input = checkbox as HTMLInputElement;
                if (!input.checked) {
                  input.checked = true;
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                  metrics.checkboxes++;
                }
              } else if (checkbox.getAttribute('role') === 'checkbox') {
                if (checkbox.getAttribute('aria-checked') !== 'true') {
                  checkbox.setAttribute('aria-checked', 'true');
                  (checkbox as HTMLElement).click();
                  metrics.checkboxes++;
                }
              }
              break;
            }
          }
        }

        const radioGroups = new Map<string, HTMLInputElement[]>();
        const radios = Array.from(document.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
        
        for (const radio of radios) {
          const name = radio.name || `__group_${Math.random()}`;
          if (!radioGroups.has(name)) {
            radioGroups.set(name, []);
          }
          radioGroups.get(name)!.push(radio);
        }

        for (const [groupName, groupRadios] of radioGroups) {
          let groupMatches = false;
          const annotated: { element: HTMLInputElement; text: string }[] = [];
          
          for (const radio of groupRadios) {
            const text = getElementText(radio);
            annotated.push({ element: radio, text });
            
            for (const pattern of patterns.filter((p: any) => p.type === 'radio')) {
              if (matchesPattern(text, pattern.pattern)) {
                groupMatches = true;
                break;
              }
            }
          }

          if (groupMatches) {
            const positive = annotated.find(a => 
              /(yes|agree|accept|confirm|allow)/i.test(a.text)
            );
            
            const toSelect = positive || annotated[0];
            if (toSelect && !toSelect.element.checked) {
              toSelect.element.checked = true;
              toSelect.element.dispatchEvent(new Event('change', { bubbles: true }));
              metrics.radios++;
            }
          }
        }

        return metrics;
      },
      {
        patterns: patterns.map(p => ({
          pattern: p.pattern.source,
          type: p.type,
          priority: p.priority,
        })),
        options: {
          aggressive: options.aggressive,
          optInMarketing: options.optInMarketing,
        },
      }
    );

    this.metrics.checkboxesChecked += result.checkboxes;
    this.metrics.radioButtonsSelected += result.radios;
    this.metrics.totalConsents += result.checkboxes + result.radios;
  }

  private async clickConsentButtons(page: Page, options: ConsentOptions): Promise<void> {
    const buttonSelectors = [
      'button:has-text("I Agree")',
      'button:has-text("Accept")',
      'button:has-text("Continue")',
      'button:has-text("Proceed")',
      'button:has-text("Confirm")',
      'text=/I\\s*Agree|Accept|Continue/i',
    ];

    for (const selector of buttonSelectors) {
      try {
        const button = await page.$(selector);
        if (button && await button.isVisible()) {
          await ScrollManager.scrollElementIntoView(page, button);
          await button.click({ timeout: 2000 });
          this.metrics.buttonsClicked++;
          this.metrics.totalConsents++;
          logger.debug('ConsentHandler', `Clicked consent button: ${selector}`);
          await page.waitForTimeout(500);
          break;
        }
      } catch (error) {
        logger.debug('ConsentHandler', `Failed to click button: ${selector}`, { error: String(error) });
      }
    }
  }

  private getActivePatterns(options: ConsentOptions): ConsentPattern[] {
    let patterns = [...this.patterns];

    if (!options.optInMarketing) {
      patterns = patterns.filter(p => 
        !/(newsletter|marketing|promotional|updates)/i.test(p.pattern.source)
      );
    }

    if (options.customPatterns) {
      const customPatterns = options.customPatterns.map((pattern, index) => ({
        pattern,
        priority: 5,
        type: 'checkbox' as const,
        action: 'check' as const,
      }));
      patterns.push(...customPatterns);
    }

    return patterns.sort((a, b) => b.priority - a.priority);
  }

  addCustomPattern(pattern: RegExp, type: 'checkbox' | 'radio' | 'button', priority: number = 5) {
    this.patterns.push({
      pattern,
      priority,
      type,
      action: type === 'button' ? 'click' : type === 'radio' ? 'select' : 'check',
    });
  }

  getMetrics() {
    return { ...this.metrics };
  }

  reset() {
    this.metrics = {
      checkboxesChecked: 0,
      radioButtonsSelected: 0,
      buttonsClicked: 0,
      totalConsents: 0,
    };
  }
}