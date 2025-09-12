export type StagehandDomainConfig = {
  enabled: boolean;
  budgetTokens: number;
  stepTimeoutMs: number;
  maxFallbackStepsPerRun?: number;
};

// Per-domain feature flags and budgets for Stagehand fallback.
// Keep disabled by default unless explicitly enabled per domain.
export const stagehandFallback: Record<string, StagehandDomainConfig> = {
  // Example domain with fallback enabled (tune to your needs)
  'invest.jll.com': { enabled: true, budgetTokens: 4000, stepTimeoutMs: 20_000, maxFallbackStepsPerRun: 6 },
  // Buildout
  'buildout.com': { enabled: true, budgetTokens: 3000, stepTimeoutMs: 15_000, maxFallbackStepsPerRun: 5 },
  'www.buildout.com': { enabled: true, budgetTokens: 3000, stepTimeoutMs: 15_000, maxFallbackStepsPerRun: 5 },
  // Crexi
  'crexi.com': { enabled: true, budgetTokens: 3000, stepTimeoutMs: 15_000, maxFallbackStepsPerRun: 5 },
  'www.crexi.com': { enabled: true, budgetTokens: 3000, stepTimeoutMs: 15_000, maxFallbackStepsPerRun: 5 },
  // Example stub (disabled)
  'example.badforms.com': { enabled: false, budgetTokens: 4000, stepTimeoutMs: 20_000 },
  // Useful for local testing against data:/about:blank (empty host)
  '': { enabled: false, budgetTokens: 2000, stepTimeoutMs: 10_000, maxFallbackStepsPerRun: 3 },
  'localhost': { enabled: false, budgetTokens: 2000, stepTimeoutMs: 10_000, maxFallbackStepsPerRun: 3 },
};

export function isStagehandGloballyDisabled(): boolean {
  return String(process.env.STAGEHAND_GLOBAL_DISABLE || '').toLowerCase() === 'true';
}

export function hostFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || '';
  } catch {
    return '';
  }
}
