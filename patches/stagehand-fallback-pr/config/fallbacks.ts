export type StagehandDomainConfig = {
  enabled: boolean;
  budgetTokens: number;
  stepTimeoutMs: number;
  maxFallbackStepsPerRun?: number;
};

export const stagehandFallback: Record<string, StagehandDomainConfig> = {
  "invest.jll.com": { enabled: true, budgetTokens: 4000, stepTimeoutMs: 20000, maxFallbackStepsPerRun: 6 },
  "example.badforms.com": { enabled: false, budgetTokens: 4000, stepTimeoutMs: 20000 },
};

export function isStagehandGloballyDisabled(): boolean {
  return String(process.env.STAGEHAND_GLOBAL_DISABLE || "").toLowerCase() === "true";
}
