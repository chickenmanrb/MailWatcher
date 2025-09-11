import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export interface FieldSelector {
  selector?: string;
  xpath?: string;
  text?: string;
  attribute?: string;
  value?: string;
  waitBefore?: number;
  scrollIntoView?: boolean;
  force?: boolean;
}

export interface PlatformConfig {
  name: string;
  urlPatterns: RegExp[];
  fields?: Record<string, FieldSelector>;
  consent?: {
    checkboxes?: FieldSelector[];
    buttons?: FieldSelector[];
    radioButtons?: FieldSelector[];
  };
  navigation?: {
    dealRoomEntry?: FieldSelector[];
    documentsTab?: FieldSelector[];
    nextButton?: FieldSelector[];
    submitButton?: FieldSelector[];
  };
  download?: {
    selectAll?: FieldSelector[];
    downloadButton?: FieldSelector[];
    downloadAll?: FieldSelector[];
    confirmDialog?: FieldSelector[];
  };
  customLogic?: {
    beforeFill?: string;
    afterFill?: string;
    beforeDownload?: string;
  };
}

class PlatformConfigManager {
  private configs: Map<string, PlatformConfig> = new Map();
  private customConfigPath?: string;

  constructor() {
    this.customConfigPath = process.env.PLATFORM_CONFIG_PATH;
    this.initializeBuiltInConfigs();
  }

  private initializeBuiltInConfigs() {
    this.addConfig({
      name: 'buildout',
      urlPatterns: [/buildout\.com/i, /buildoutnow\.com/i],
      fields: {
        email: { selector: 'input[type="email"], input[name*="email"]' },
        firstName: { selector: 'input[name*="first"], input[placeholder*="First"]' },
        lastName: { selector: 'input[name*="last"], input[placeholder*="Last"]' },
        company: { selector: 'input[name*="company"], input[placeholder*="Company"]' },
        phone: { selector: 'input[type="tel"], input[name*="phone"]' },
      },
      consent: {
        checkboxes: [
          { selector: 'input[type="checkbox"][name*="agree"]' },
          { selector: 'input[type="checkbox"][name*="nda"]' },
          { text: 'I agree to the Confidentiality Agreement' },
        ],
        buttons: [
          { selector: 'button:has-text("I Agree")' },
          { selector: 'button:has-text("Accept & Continue")' },
        ],
      },
      navigation: {
        dealRoomEntry: [
          { selector: 'a:has-text("Enter Deal Room")' },
          { selector: 'button:has-text("Continue to Deal Room")' },
        ],
        documentsTab: [
          { selector: '[role="tab"]:has-text("Documents")' },
          { selector: 'a:has-text("Files")' },
        ],
      },
      download: {
        downloadAll: [
          { selector: 'button:has-text("Download All")' },
          { selector: 'a[title*="Download All"]' },
        ],
      },
    });

    this.addConfig({
      name: 'crexi',
      urlPatterns: [/crexi\.com/i],
      fields: {
        email: { selector: '#email, input[name="email"]' },
        firstName: { selector: '#firstName, input[name="firstName"]' },
        lastName: { selector: '#lastName, input[name="lastName"]' },
        company: { selector: '#company, input[name="company"]' },
        phone: { selector: '#phone, input[name="phone"]' },
      },
      consent: {
        checkboxes: [
          { selector: 'input[type="checkbox"][name*="confidentiality"]' },
          { selector: 'mat-checkbox[formcontrolname*="agree"]' },
        ],
      },
      navigation: {
        dealRoomEntry: [
          { selector: 'button:has-text("View Property Details")' },
          { selector: 'a:has-text("Documents")' },
        ],
      },
      download: {
        downloadAll: [
          { selector: 'button:has-text("Download All Documents")' },
        ],
      },
    });

    this.addConfig({
      name: 'rcm',
      urlPatterns: [/rcm1\.net/i, /lightbox\.rcm/i],
      fields: {
        email: { selector: 'input[ng-model*="email"]' },
        firstName: { selector: 'input[ng-model*="firstName"]' },
        lastName: { selector: 'input[ng-model*="lastName"]' },
        company: { selector: 'input[ng-model*="company"]' },
      },
      consent: {
        checkboxes: [
          { selector: 'input[type="checkbox"][ng-model*="agree"]' },
        ],
        buttons: [
          { selector: 'button[ng-click*="accept"]' },
        ],
      },
      navigation: {
        dealRoomEntry: [
          { text: 'Enter Virtual Deal Room' },
        ],
        documentsTab: [
          { selector: 'a[ui-sref*="documents"]' },
        ],
      },
      download: {
        selectAll: [
          { selector: 'input[type="checkbox"][ng-model*="selectAll"]' },
          { selector: 'th input[type="checkbox"]' },
        ],
        downloadButton: [
          { selector: 'button.vdr-download-button' },
          { text: 'Download' },
        ],
        confirmDialog: [
          { selector: '[role="dialog"] button:has-text("OK")' },
          { selector: '.modal button:has-text("Yes")' },
        ],
      },
    });

    this.addConfig({
      name: 'dealcloud',
      urlPatterns: [/dealcloud\.com/i, /dealcloud\.app/i],
      fields: {
        email: { selector: 'input[data-field="Email"]' },
        firstName: { selector: 'input[data-field="FirstName"]' },
        lastName: { selector: 'input[data-field="LastName"]' },
        company: { selector: 'input[data-field="Company"]' },
      },
      consent: {
        checkboxes: [
          { selector: 'input[type="checkbox"][data-field*="Accept"]' },
        ],
      },
      navigation: {
        documentsTab: [
          { selector: '[data-tab="documents"]' },
        ],
      },
      download: {
        downloadAll: [
          { selector: 'button[data-action="download-all"]' },
        ],
      },
    });
  }

  async loadCustomConfig() {
    if (!this.customConfigPath) return;

    try {
      const content = await fs.readFile(this.customConfigPath, 'utf-8');
      const configs = JSON.parse(content) as PlatformConfig[];
      
      for (const config of configs) {
        config.urlPatterns = config.urlPatterns.map(p => new RegExp(p));
        this.addConfig(config);
      }
      
      logger.info('PlatformConfig', `Loaded ${configs.length} custom configurations`);
    } catch (error) {
      logger.warn('PlatformConfig', 'Failed to load custom config', { error: String(error) });
    }
  }

  addConfig(config: PlatformConfig) {
    this.configs.set(config.name, config);
    logger.debug('PlatformConfig', `Added configuration for ${config.name}`);
  }

  getConfigForUrl(url: string): PlatformConfig | null {
    for (const config of this.configs.values()) {
      if (config.urlPatterns.some(pattern => pattern.test(url))) {
        logger.info('PlatformConfig', `Matched platform: ${config.name}`, { url });
        return config;
      }
    }
    return null;
  }

  getAllConfigs(): PlatformConfig[] {
    return Array.from(this.configs.values());
  }

  updateConfig(name: string, updates: Partial<PlatformConfig>) {
    const existing = this.configs.get(name);
    if (existing) {
      this.configs.set(name, { ...existing, ...updates });
      logger.info('PlatformConfig', `Updated configuration for ${name}`);
    }
  }

  async saveCustomConfig(configs: PlatformConfig[], outputPath?: string) {
    const savePath = outputPath || this.customConfigPath;
    if (!savePath) {
      throw new Error('No output path specified for custom config');
    }

    const serializable = configs.map(config => ({
      ...config,
      urlPatterns: config.urlPatterns.map(r => r.source),
    }));

    await fs.mkdir(path.dirname(savePath), { recursive: true });
    await fs.writeFile(savePath, JSON.stringify(serializable, null, 2));
    logger.info('PlatformConfig', `Saved ${configs.length} configurations to ${savePath}`);
  }
}

export const platformConfig = new PlatformConfigManager();

export async function initializePlatformConfig() {
  await platformConfig.loadCustomConfig();
}

export function getPlatformSelectors(url: string): PlatformConfig | null {
  return platformConfig.getConfigForUrl(url);
}