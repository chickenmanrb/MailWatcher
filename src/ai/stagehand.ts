import type { Page } from 'playwright';
import logger from '../util/logger.js';

export type StagehandAdapterOpts = {
  domSettleTimeoutMs?: number;
  provider?: 'openai' | 'anthropic';
  model?: string;
};

export type StagehandAdapter = {
  act: (instruction: string, opts?: { preview?: boolean; timeoutMs?: number }) => Promise<any>;
  observe: (instruction: string, timeoutMs?: number) => Promise<any>;
  agent?: any;
  attached: boolean;
};

async function dynamicImportStagehand(): Promise<any | null> {
  try {
    // Dynamic import so builds succeed without the package installed
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    const mod: any = await import('@browserbasehq/stagehand');
    return mod?.Stagehand ? mod : null;
  } catch (err) {
    logger.debug('Stagehand not available (dynamic import failed): %s', (err as Error)?.message);
    return null;
  }
}

export async function isStagehandAvailable(): Promise<boolean> {
  const mod = await dynamicImportStagehand();
  return Boolean(mod);
}

export async function createStagehandForPage(page: Page, opts: StagehandAdapterOpts = {}): Promise<StagehandAdapter | null> {
  const mod = await dynamicImportStagehand();
  if (!mod) return null;

  const Stagehand = mod.Stagehand as any;

  const env = process.env.STAGEHAND_ENV === 'BROWSERBASE' ? 'BROWSERBASE' : 'LOCAL';
  const enableCaching = String(process.env.STAGEHAND_ENABLE_CACHE || 'false') === 'true';
  const verbose = Number(process.env.STAGEHAND_VERBOSE ?? 1);

  let instance: any;
  let attached = false;
  try {
    // Prefer constructors that accept an existing Playwright page (session continuity)
    // Many variants exist; try to pass page where supported.
    instance = new Stagehand({ env, enableCaching, verbose, domSettleTimeoutMs: opts.domSettleTimeoutMs ?? 30_000, page });
    attached = true;
  } catch (e1) {
    logger.debug('Stagehand ctor with {page} failed, trying without page: %s', (e1 as Error)?.message);
    try {
      instance = new Stagehand({ env, enableCaching, verbose, domSettleTimeoutMs: opts.domSettleTimeoutMs ?? 30_000 });
      // Some SDKs expose an attach method
      if (typeof instance.attach === 'function') {
        await instance.attach(page);
        attached = true;
      } else if (instance?.page?.context) {
        // If the instance already has an internal page, we cannot guarantee continuity
        attached = false;
      }
    } catch (e2) {
      logger.error('Failed to initialize Stagehand: %s', (e2 as Error)?.message);
      return null;
    }
  }

  const shPage = instance?.page ?? instance;

  const act = async (instruction: string, { preview = true, timeoutMs = 20_000 }: { preview?: boolean; timeoutMs?: number } = {}) => {
    if (!shPage?.act) throw new Error('Stagehand page.act not available');
    return await shPage.act(instruction, { preview, timeoutMs });
  };

  const observe = async (instruction: string, timeoutMs = 20_000) => {
    if (!shPage?.observe) throw new Error('Stagehand page.observe not available');
    return await shPage.observe(instruction, { timeoutMs });
  };

  const agent = typeof instance?.agent === 'function'
    ? instance.agent({ provider: opts.provider ?? 'openai', model: opts.model ?? 'computer-use-preview' })
    : undefined;

  return { act, observe, agent, attached };
}

