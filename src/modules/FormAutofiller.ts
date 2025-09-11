import type { Page, Frame } from 'playwright';
import { logger } from '../utils/logger.js';
import { fieldMatcher, FuzzyMatcher } from '../matchers/fuzzyMatcher.js';
import { ScrollManager } from '../utils/scrollManager.js';
import { formRetry } from '../utils/retry.js';
import { loadFormData } from '../config/formData.js';
import type { FieldSelector, PlatformConfig } from '../config/platformSelectors.js';

export interface AutofillOptions {
  aggressive?: boolean;
  optInMarketing?: boolean;
  submit?: boolean;
  onlyRequired?: boolean;
  maxSteps?: number;
  skipSensitive?: boolean;
  debug?: boolean;
  platformConfig?: PlatformConfig;
}

export interface FormData {
  EMAIL?: string;
  PASSWORD?: string;
  USERNAME?: string;
  FULL_NAME?: string;
  FIRST_NAME?: string;
  LAST_NAME?: string;
  COMPANY?: string;
  TITLE?: string;
  PHONE?: string;
  WEBSITE?: string;
  ADDRESS1?: string;
  ADDRESS2?: string;
  CITY?: string;
  STATE?: string;
  POSTAL_CODE?: string;
  COUNTRY?: string;
  CREDIT_CARD?: string;
  CVV?: string;
  EXPIRY?: string;
  CARDHOLDER_NAME?: string;
}

const EXPANDED_AUTOCOMPLETE_MAP: Record<string, keyof FormData> = {
  'email': 'EMAIL',
  'username': 'USERNAME',
  'name': 'FULL_NAME',
  'given-name': 'FIRST_NAME',
  'additional-name': 'FULL_NAME',
  'family-name': 'LAST_NAME',
  'nickname': 'USERNAME',
  'organization': 'COMPANY',
  'organization-title': 'TITLE',
  'street-address': 'ADDRESS1',
  'address-line1': 'ADDRESS1',
  'address-line2': 'ADDRESS2',
  'address-level1': 'STATE',
  'address-level2': 'CITY',
  'address-level3': 'ADDRESS2',
  'address-level4': 'ADDRESS2',
  'country': 'COUNTRY',
  'country-name': 'COUNTRY',
  'postal-code': 'POSTAL_CODE',
  'cc-name': 'CARDHOLDER_NAME',
  'cc-given-name': 'FIRST_NAME',
  'cc-family-name': 'LAST_NAME',
  'cc-number': 'CREDIT_CARD',
  'cc-exp': 'EXPIRY',
  'cc-exp-month': 'EXPIRY',
  'cc-exp-year': 'EXPIRY',
  'cc-csc': 'CVV',
  'cc-type': 'CREDIT_CARD',
  'tel': 'PHONE',
  'tel-national': 'PHONE',
  'tel-area-code': 'PHONE',
  'tel-local': 'PHONE',
  'tel-extension': 'PHONE',
  'url': 'WEBSITE',
  'photo': 'WEBSITE',
  'current-password': 'PASSWORD',
  'new-password': 'PASSWORD',
  'one-time-code': 'PASSWORD',
  'honorific-prefix': 'TITLE',
  'honorific-suffix': 'TITLE',
};

const SENSITIVE_PATTERNS = /(ssn|social[\s_-]*security|credit[\s_-]*card|card[\s_-]*number|cc[-_\s]*num|cvv|cvc|security[\s_-]*code|iban|swift|routing|account[\s_-]*number|bank|dob|date.*birth|birth.*date|passport|driver|licen[cs]e|tax[\s_-]*id)/i;

export class FormAutofiller {
  private data: FormData = {};
  private filledFields: Map<string, string> = new Map();
  private metrics = {
    fieldsAttempted: 0,
    fieldsFilled: 0,
    fieldsSkipped: 0,
    formsFilled: 0,
  };

  async initialize() {
    const fileData = await loadFormData().catch(() => ({}));
    const envData = this.loadFromEnvironment();
    this.data = { ...envData, ...fileData };
    logger.info('FormAutofiller', 'Initialized with data sources', {
      hasFileData: Object.keys(fileData).length > 0,
      hasEnvData: Object.keys(envData).length > 0,
    });
  }

  private loadFromEnvironment(): FormData {
    const env = (keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = process.env[key];
        if (value?.trim()) return value.trim();
      }
      return undefined;
    };

    return {
      EMAIL: env(['EMAIL', 'USER_EMAIL', 'LOGIN_EMAIL']),
      PASSWORD: env(['PASSWORD', 'PASS', 'LOGIN_PASSWORD']),
      USERNAME: env(['USERNAME', 'LOGIN_USER', 'USER_NAME']),
      FULL_NAME: env(['FULL_NAME', 'NAME', 'USER_FULL_NAME']),
      FIRST_NAME: env(['FIRST_NAME', 'GIVEN_NAME', 'FNAME', 'USER_FIRST_NAME']),
      LAST_NAME: env(['LAST_NAME', 'SURNAME', 'LNAME', 'FAMILY_NAME', 'USER_LAST_NAME']),
      COMPANY: env(['COMPANY', 'ORG', 'ORGANIZATION', 'USER_COMPANY', 'COMPANY_NAME']),
      TITLE: env(['TITLE', 'JOB_TITLE', 'USER_TITLE', 'POSITION']),
      PHONE: env(['PHONE', 'MOBILE', 'TEL', 'USER_PHONE', 'PHONE_NUMBER']),
      WEBSITE: env(['WEBSITE', 'URL', 'HOMEPAGE', 'SITE']),
      ADDRESS1: env(['ADDRESS1', 'STREET', 'STREET1', 'ADDRESS_LINE1']),
      ADDRESS2: env(['ADDRESS2', 'APT', 'SUITE', 'UNIT', 'ADDRESS_LINE2']),
      CITY: env(['CITY', 'TOWN', 'LOCALITY']),
      STATE: env(['STATE', 'PROVINCE', 'REGION']),
      POSTAL_CODE: env(['POSTAL_CODE', 'ZIP', 'ZIPCODE', 'POSTCODE']),
      COUNTRY: env(['COUNTRY', 'NATION']),
    };
  }

  async autofillPage(
    page: Page,
    options: AutofillOptions = {}
  ): Promise<number> {
    const timer = logger.time('FormAutofiller', 'autofillPage');
    let totalFilled = 0;

    try {
      if (options.platformConfig?.fields) {
        totalFilled += await this.fillWithPlatformConfig(page, options.platformConfig, options);
      }

      for (const frame of page.frames()) {
        totalFilled += await this.autofillFrame(frame, options);
      }

      this.metrics.formsFilled++;
      logger.info('FormAutofiller', `Filled ${totalFilled} fields`, this.metrics);
    } finally {
      timer();
    }

    return totalFilled;
  }

  private async fillWithPlatformConfig(
    page: Page,
    config: PlatformConfig,
    options: AutofillOptions
  ): Promise<number> {
    let filled = 0;

    for (const [fieldType, selector] of Object.entries(config.fields || {})) {
      const value = this.data[fieldType.toUpperCase() as keyof FormData];
      if (!value) continue;

      try {
        await this.fillFieldWithSelector(page, selector, value, options);
        filled++;
      } catch (error) {
        logger.debug('FormAutofiller', `Failed to fill ${fieldType} with platform config`, { error: String(error) });
      }
    }

    return filled;
  }

  private async fillFieldWithSelector(
    page: Page,
    selector: FieldSelector,
    value: string,
    options: AutofillOptions
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

    if (selector.scrollIntoView) {
      await ScrollManager.scrollElementIntoView(page, element);
    }

    if (selector.waitBefore) {
      await page.waitForTimeout(selector.waitBefore);
    }

    await element.fill(value, { force: selector.force });
    return true;
  }

  private async autofillFrame(
    frame: Frame,
    options: AutofillOptions
  ): Promise<number> {
    const filledCount = await frame.evaluate(
      ({ data, autocompleteMap, options, sensitivePattern }: any) => {
        let filled = 0;
        const inputs = Array.from(document.querySelectorAll('input, textarea, select')) as (HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement)[];

        for (const element of inputs) {
          if (!isElementVisible(element)) continue;
          if (shouldSkipElement(element, options, sensitivePattern)) continue;

          const fieldInfo = getFieldInfo(element);
            const fieldType = detectFieldType(fieldInfo, autocompleteMap);
          
            if (fieldType && (data as any)[fieldType]) {
              if (fillField(element as any, (data as any)[fieldType])) {
                filled++;
              }
            }
        }

        function isElementVisible(el: HTMLElement): boolean {
          const style = window.getComputedStyle(el);
          return style.visibility !== 'hidden' && 
                 style.display !== 'none' && 
                 el.offsetParent !== null;
        }

        function shouldSkipElement(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, opts: any, pattern: string): boolean {
          const type = (el as HTMLInputElement).type?.toLowerCase();
          if (['button', 'submit', 'reset', 'file', 'image', 'hidden'].includes(type)) return true;
          
          if (opts.onlyRequired) {
            const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
            if (!required) return true;
          }

          if (opts.skipSensitive) {
            const descriptor = getFieldDescriptor(el);
            if (new RegExp(pattern, 'i').test(descriptor)) return true;
          }

          const value = el.value?.trim();
          if (value && value !== '') return true;

          return false;
        }

        function getFieldInfo(el: HTMLElement) {
          return {
            id: el.getAttribute('id') || '',
            name: el.getAttribute('name') || '',
            type: (el as HTMLInputElement).type || el.tagName.toLowerCase(),
            autocomplete: el.getAttribute('autocomplete') || '',
            placeholder: (el as HTMLInputElement).placeholder || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            label: getElementLabel(el),
            context: getElementContext(el),
          };
        }

        function getElementLabel(el: HTMLElement): string {
          const id = el.id;
          if (id) {
            const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (label) return label.textContent || '';
          }
          const closestLabel = el.closest('label');
          if (closestLabel) return closestLabel.textContent || '';
          return '';
        }

        function getElementContext(el: HTMLElement): string {
          const parent = el.parentElement;
          if (!parent) return '';
          return (parent.textContent || '').slice(0, 200);
        }

        function getFieldDescriptor(el: HTMLElement): string {
          const info = getFieldInfo(el);
          return `${info.name} ${info.id} ${info.ariaLabel} ${info.placeholder} ${info.label} ${info.context}`;
        }

        function detectFieldType(info: any, map: any): string | null {
          if (info.autocomplete && map[info.autocomplete]) {
            return map[info.autocomplete];
          }

          const descriptor = Object.values(info).join(' ').toLowerCase();
          
          if (info.type === 'email' || descriptor.includes('email')) return 'EMAIL';
          if (info.type === 'tel' || descriptor.includes('phone') || descriptor.includes('mobile')) return 'PHONE';
          if (info.type === 'password') return 'PASSWORD';
          if (descriptor.includes('first') && descriptor.includes('name')) return 'FIRST_NAME';
          if (descriptor.includes('last') && descriptor.includes('name')) return 'LAST_NAME';
          if (descriptor.includes('company') || descriptor.includes('organization')) return 'COMPANY';
          if (descriptor.includes('title') || descriptor.includes('position')) return 'TITLE';
          if (descriptor.includes('address') && !descriptor.includes('email')) return 'ADDRESS1';
          if (descriptor.includes('city') || descriptor.includes('town')) return 'CITY';
          if (descriptor.includes('state') || descriptor.includes('province')) return 'STATE';
          if (descriptor.includes('zip') || descriptor.includes('postal')) return 'POSTAL_CODE';
          if (descriptor.includes('country')) return 'COUNTRY';
          if (descriptor.includes('website') || descriptor.includes('url')) return 'WEBSITE';
          
          return null;
        }

        function fillField(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): boolean {
          try {
            if (el.tagName === 'SELECT') {
              (el as HTMLSelectElement).value = value;
            } else {
              const proto = Object.getPrototypeOf(el);
              const desc = Object.getOwnPropertyDescriptor(proto, 'value');
              if (desc?.set) {
                desc.set.call(el, value);
              } else {
                (el as any).value = value;
              }
            }
            
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            return true;
          } catch {
            return false;
          }
        }

        return filled;
      },
      {
        data: this.data,
        autocompleteMap: EXPANDED_AUTOCOMPLETE_MAP,
        options: {
          onlyRequired: options.onlyRequired,
          skipSensitive: options.skipSensitive,
        },
        sensitivePattern: SENSITIVE_PATTERNS.source,
      }
    );

    this.metrics.fieldsFilled += filledCount;
    return filledCount;
  }

  getPhoneVariants(phone?: string): string[] {
    const value = (phone || this.data.PHONE || '').trim();
    if (!value) return [];

    const digits = value.replace(/\D+/g, '');
    const last10 = digits.slice(-10);
    
    const variants = [
      value,
      digits,
      last10,
      last10 ? `${last10.slice(0, 3)}-${last10.slice(3, 6)}-${last10.slice(6)}` : '',
      last10 ? `(${last10.slice(0, 3)}) ${last10.slice(3, 6)}-${last10.slice(6)}` : '',
      last10 ? `+1${last10}` : '',
      digits.startsWith('+') ? digits : `+${digits}`,
    ].filter(Boolean);

    return Array.from(new Set(variants));
  }

  getMetrics() {
    return { ...this.metrics };
  }

  reset() {
    this.filledFields.clear();
    this.metrics = {
      fieldsAttempted: 0,
      fieldsFilled: 0,
      fieldsSkipped: 0,
      formsFilled: 0,
    };
  }
}
