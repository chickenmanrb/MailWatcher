import { Stagehand } from "@browserbasehq/stagehand";

export type StagehandAdapterOpts = {
  domSettleTimeoutMs?: number;
  provider?: "openai"|"anthropic";
  model?: string;
};

export const makeStagehand = (opts: StagehandAdapterOpts = {}) => {
  const stagehand = new Stagehand({
    env: process.env.STAGEHAND_ENV === "BROWSERBASE" ? "BROWSERBASE" : "LOCAL",
    enableCaching: String(process.env.STAGEHAND_ENABLE_CACHE || "false") === "true",
    verbose: Number(process.env.STAGEHAND_VERBOSE ?? 1),
    domSettleTimeoutMs: opts.domSettleTimeoutMs ?? 30_000,
  });

  const page = stagehand.page;

  const tryAct = async (instruction: string, {
    preview = true,
    timeoutMs = 20_000,
  }: { preview?: boolean; timeoutMs?: number } = {}) => {
    return await page.act(instruction, { preview, timeoutMs });
  };

  const tryObserve = async (instruction: string, timeoutMs = 20_000) => {
    return await page.observe(instruction, { timeoutMs });
  };

  const agent = stagehand.agent({
    provider: opts.provider ?? "openai",
    model: opts.model ?? "computer-use-preview",
  });

  return { stagehand, page, tryAct, tryObserve, agent };
};
