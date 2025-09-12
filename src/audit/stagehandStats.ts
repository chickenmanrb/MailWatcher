import type { Page } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FallbackRunContext } from '../handlers/smartStep.js';
import { stagehandFallback, hostFromUrl, type StagehandDomainConfig } from '../config/stagehandFallback.js';

export function makeStagehandContext(page: Page, workingDir: string): { ctx: FallbackRunContext; host: string; cfg?: StagehandDomainConfig } {
  const host = hostFromUrl(page.url());
  const cfg = stagehandFallback[host];
  const ctx: FallbackRunContext = {
    stepsUsed: 0,
    maxSteps: cfg?.maxFallbackStepsPerRun ?? 3,
    artifactsDir: path.join(workingDir, 'stagehand')
  };
  return { ctx, host, cfg };
}

export async function writeStagehandStats(workingDir: string, host: string, cfg: StagehandDomainConfig | undefined, ctx: FallbackRunContext): Promise<void> {
  try {
    const statsPath = path.join(workingDir, 'stagehand-stats.json');
    await fs.writeFile(statsPath, JSON.stringify({ host, enabled: Boolean(cfg?.enabled), steps_used: ctx.stepsUsed, max_steps: ctx.maxSteps, artifactsDir: ctx.artifactsDir }, null, 2), 'utf8');
  } catch {}
}

