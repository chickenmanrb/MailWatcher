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
  'invest.jll.com': { enabled: false, budgetTokens: 4000, stepTimeoutMs: 20_000, maxFallbackStepsPerRun: 6 },
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

