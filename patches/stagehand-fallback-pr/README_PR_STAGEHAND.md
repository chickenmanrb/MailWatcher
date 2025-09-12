# PR: Stagehand Fallback for Problematic Forms

This PR introduces a targeted AI fallback using **Stagehand** for forms that defeat our deterministic Playwright handlers.

## What this does
- Keeps our existing deterministic handlers **as the first choice**.
- If a field or submit action isn't confidently resolved via a11y-first locators, we escalate to Stagehand **for that step only**.
- Adds per-domain feature flags and budgets to control cost and risk.
- Captures logs, screenshots/HTML snapshots, and token usage for observability.

## New files
- `config/fallbacks.ts` — per-domain toggle & budgets
- `lib/ai/stagehand.ts` — thin wrapper over Stagehand (`act`, `observe`, optional agent)
- `lib/handlers/smartStep.ts` — helpers that try deterministic first, then Stagehand fallback
- `lib/downloads/osWatcher.ts` — optional download fallback (system Downloads folder watcher)
- `tests/e2e/stagehand_fallback.spec.ts` — canary tests for a representative problem form

## Install
```bash
npm i @browserbasehq/stagehand zod
# playwright already present
```

## Env
Add the following to your secret store / .env.*:
```ini
OPENAI_API_KEY=***
ANTHROPIC_API_KEY=***
STAGEHAND_ENV=LOCAL          # or BROWSERBASE
STAGEHAND_VERBOSE=1          # 0|1|2
STAGEHAND_ENABLE_CACHE=true
STAGEHAND_GLOBAL_DISABLE=false
```

## Playwright config (optional notes)
- No change is strictly required. These helpers plug into existing flows.
- Recommended: ensure screenshots+traces on failure to capture pre/post Stagehand actions.

## Rollout
1) Merge behind feature flags (disabled by default except for a couple of target domains).
2) Run in CI in "shadow mode" for one week—collect metrics, do not gate pass/fail yet.
3) Enable for those domains fully after success metrics improve.
4) Expand to other domains as needed.

## Success metrics
- Completion rate on targeted forms
- Download success rate after Stagehand-submit
- Avg fallback steps per run (should trend down as cache stabilizes)
- $/run (token usage), flake/timeouts

## Kill switch
Set `STAGEHAND_GLOBAL_DISABLE=true` to disable all AI fallbacks instantly.
