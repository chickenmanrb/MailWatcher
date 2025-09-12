import type { Page } from 'playwright';
import logger from '../util/logger.js';
import { createStagehandForPage } from '../ai/stagehand.js';
import { stagehandFallback, isStagehandGloballyDisabled, hostFromUrl } from '../config/stagehandFallback.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export type FallbackRunContext = {
  stepsUsed: number;
  maxSteps: number;
  artifactsDir?: string;
};

export async function ensureArtifactsDir(ctx?: FallbackRunContext): Promise<string | undefined> {
  if (!ctx?.artifactsDir) return undefined;
  await fs.mkdir(ctx.artifactsDir, { recursive: true }).catch(() => {});
  return ctx.artifactsDir;
}

function siteConfigFor(page: Page) {
  const host = hostFromUrl(page.url());
  return stagehandFallback[host];
}

async function deterministicFill(page: Page, label: string, value: string): Promise<boolean> {
  const tries = [
    page.getByLabel(label, { exact: true }),
    page.getByPlaceholder(label),
    page.getByRole('textbox', { name: label }),
    page.locator(`input[aria-label="${label}"]`),
  ];
  for (const c of tries) {
    try { await c.fill(value, { timeout: 2500 }); return true; } catch {}
  }
  return false;
}

async function deterministicClickSubmit(page: Page): Promise<boolean> {
  const tries = [
    page.getByRole('button', { name: /submit|continue|next|apply|download/i }),
    page.locator('button[type="submit"]'),
    page.getByRole('link', { name: /download|export/i }),
  ];
  for (const c of tries) {
    try { await c.click({ timeout: 2000 }); return true; } catch {}
  }
  return false;
}

export type SmartStepOptions = {
  ctx?: FallbackRunContext;
};

async function snapshot(page: Page, base: string, name: string) {
  try {
    await page.screenshot({ path: path.join(base, `${name}.png`) }).catch(() => {});
    const html = await page.content().catch(() => '');
    await fs.writeFile(path.join(base, `${name}.html`), html).catch(() => {});
  } catch {}
}

export async function fillFieldSmart(page: Page, label: string, value: string, opts: SmartStepOptions = {}) {
  // 1) deterministic first
  if (await deterministicFill(page, label, value)) {
    logger.info('smartStep.fill: deterministic success for "%s"', label);
    return { method: 'deterministic' as const };
  }

  // 2) gated Stagehand fallback
  if (isStagehandGloballyDisabled()) {
    logger.info('smartStep.fill: Stagehand globally disabled; deterministic failed for "%s"', label);
    throw new Error(`Stagehand globally disabled; failed deterministic fill for ${label}`);
  }
  const cfg = siteConfigFor(page);
  if (!cfg?.enabled) {
    logger.info('smartStep.fill: Stagehand disabled for host; deterministic failed for "%s"', label);
    throw new Error(`Stagehand fallback disabled for this host; failed deterministic fill for ${label}`);
  }

  if (opts.ctx) {
    if (opts.ctx.stepsUsed >= (opts.ctx.maxSteps ?? Number.MAX_SAFE_INTEGER)) {
      throw new Error('Stagehand fallback step budget exceeded');
    }
  }

  const adapter = await createStagehandForPage(page).catch((e) => { logger.error('Stagehand init error: %s', (e as Error)?.message); return null; });
  if (!adapter) throw new Error('Stagehand not available');

  const artifactsDir = await ensureArtifactsDir(opts.ctx);
  if (artifactsDir) await snapshot(page, artifactsDir, `pre-fill-${Date.now()}`);

  const instruction = `Find the input field labeled or described as "${label}" and type exactly: ${JSON.stringify(value)}.`;
  await adapter.act(instruction, { preview: true, timeoutMs: cfg.stepTimeoutMs });

  if (artifactsDir) await snapshot(page, artifactsDir, `post-fill-${Date.now()}`);
  if (opts.ctx) opts.ctx.stepsUsed += 1;

  logger.info('smartStep.fill: stagehand acted for "%s"', label);
  return { method: 'stagehand' as const };
}

export async function clickSubmitSmart(page: Page, opts: SmartStepOptions = {}) {
  if (await deterministicClickSubmit(page)) {
    logger.info('smartStep.submit: deterministic success');
    return { method: 'deterministic' as const };
  }

  if (isStagehandGloballyDisabled()) {
    logger.info('smartStep.submit: Stagehand globally disabled; deterministic failed');
    throw new Error('Stagehand globally disabled; failed deterministic submit');
  }
  const cfg = siteConfigFor(page);
  if (!cfg?.enabled) {
    logger.info('smartStep.submit: Stagehand disabled for host; deterministic failed');
    throw new Error('Stagehand fallback disabled for this host; failed deterministic submit');
  }

  if (opts.ctx) {
    if (opts.ctx.stepsUsed >= (opts.ctx.maxSteps ?? Number.MAX_SAFE_INTEGER)) {
      throw new Error('Stagehand fallback step budget exceeded');
    }
  }

  const adapter = await createStagehandForPage(page).catch((e) => { logger.error('Stagehand init error: %s', (e as Error)?.message); return null; });
  if (!adapter) throw new Error('Stagehand not available');

  const artifactsDir = await ensureArtifactsDir(opts.ctx);
  if (artifactsDir) await snapshot(page, artifactsDir, `pre-submit-${Date.now()}`);

  await adapter.act('Click the primary submit/continue/next/apply/download button on this page and wait for navigation.', { preview: true, timeoutMs: cfg.stepTimeoutMs });

  if (artifactsDir) await snapshot(page, artifactsDir, `post-submit-${Date.now()}`);
  if (opts.ctx) opts.ctx.stepsUsed += 1;

  logger.info('smartStep.submit: stagehand acted');
  return { method: 'stagehand' as const };
}

