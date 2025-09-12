import { Page } from "@playwright/test";
import { makeStagehand } from "../ai/stagehand";
import { stagehandFallback, isStagehandGloballyDisabled } from "../../config/fallbacks";

function siteConfigFor(page: Page) {
  const host = new URL(page.url()).host;
  return stagehandFallback[host];
}

async function deterministicFill(page: Page, label: string, value: string): Promise<boolean> {
  const tries = [
    page.getByLabel(label, { exact: true }),
    page.getByPlaceholder(label),
    page.getByRole("textbox", { name: label }),
    page.locator(`input[aria-label="${label}"]`),
  ];
  for (const c of tries) {
    try { await c.fill(value, { timeout: 3000 }); return true; } catch {}
  }
  return false;
}

async function deterministicClickSubmit(page: Page): Promise<boolean> {
  const tries = [
    page.getByRole("button", { name: /submit|continue|next|apply|download/i }),
    page.locator('button[type="submit"]'),
    page.getByRole("link", { name: /download|export/i }),
  ];
  for (const c of tries) {
    try { await c.click({ timeout: 2500 }); return true; } catch {}
  }
  return false;
}

export async function fillFieldSmart(page: Page, label: string, value: string) {
  // 1) deterministic first
  if (await deterministicFill(page, label, value)) {
    return { method: "deterministic" as const };
  }

  // 2) gated Stagehand fallback
  if (isStagehandGloballyDisabled()) {
    throw new Error(`Stagehand globally disabled; failed deterministic fill for ${label}`);
  }
  const cfg = siteConfigFor(page);
  if (!cfg?.enabled) {
    throw new Error(`Stagehand fallback disabled for this host; failed deterministic fill for ${label}`);
  }

  const { tryAct } = makeStagehand();
  const instruction = `Find the input field for "${label}" and type: ${JSON.stringify(value)}.`;
  await tryAct(instruction, { preview: true, timeoutMs: cfg.stepTimeoutMs });
  return { method: "stagehand" as const };
}

export async function clickSubmitSmart(page: Page) {
  if (await deterministicClickSubmit(page)) {
    return { method: "deterministic" as const };
  }
  if (isStagehandGloballyDisabled()) {
    throw new Error(`Stagehand globally disabled; failed deterministic submit`);
  }
  const cfg = siteConfigFor(page);
  if (!cfg?.enabled) {
    throw new Error(`Stagehand fallback disabled for this host; failed deterministic submit`);
  }

  const { tryAct } = makeStagehand();
  await tryAct("Click the primary submit or continue button on this page and wait for navigation.", { preview: true, timeoutMs: cfg.stepTimeoutMs });
  return { method: "stagehand" as const };
}
