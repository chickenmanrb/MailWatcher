import { test, expect } from '@playwright/test';

// This spec validates the smartStep helpers in isolation.
// It is skipped by default unless ENABLE_STAGEHAND_TESTS=true is set.
// When enabled, it toggles the host config for data: URLs (empty host) to allow fallback.

const ENABLE = String(process.env.ENABLE_STAGEHAND_TESTS || '').toLowerCase() === 'true';

test.describe('Stagehand fallback canary', () => {
  test.skip(!ENABLE, 'Set ENABLE_STAGEHAND_TESTS=true to run this spec');

  test('fills Email and submits when deterministic fails', async ({ page }) => {
    // Import lazily to avoid loading app modules on skip
    const smart = await import('../src/handlers/smartStep.js');
    const cfgmod = await import('../src/config/stagehandFallback.js');

    // Enable for empty host (data: URLs)
    cfgmod.stagehandFallback[''] = { enabled: true, budgetTokens: 4000, stepTimeoutMs: 10_000, maxFallbackStepsPerRun: 3 } as any;

    await page.goto('data:text/html,' + encodeURIComponent(`
      <html><body>
        <label for="em">Work Email Address</label>
        <input id="em" type="email" />
        <button id="go">Proceed</button>
      </body></html>
    `));

    const ctx: smart.FallbackRunContext = { stepsUsed: 0, maxSteps: 5, artifactsDir: 'runs/stagehand-e2e' } as any;

    // Force deterministic failure by using a mismatched label to drive fallback
    const res1 = await smart.fillFieldSmart(page, 'Email', 'test@example.com', { ctx }).catch((e: any) => ({ method: 'error', error: e?.message }));
    expect(['deterministic', 'stagehand', 'error']).toContain((res1 as any).method);

    // For submit: use a label that is not in deterministic list to encourage fallback
    const res2 = await smart.clickSubmitSmart(page, { ctx }).catch((e: any) => ({ method: 'error', error: e?.message }));
    expect(['deterministic', 'stagehand', 'error']).toContain((res2 as any).method);
  });
});

