# Repository Guidelines

## Project Structure & Modules
- `src/` TypeScript source organized by feature:
  - `handlers/` site-specific ingestion flows (e.g., `rcm.ts`, `crexi.ts`).
  - `browser/` Playwright session and download helpers.
  - `upload/` SharePoint Graph uploads.
  - `audit/` receipts and zipping artifacts.
  - `webhook/server.ts` lightweight HTTP webhook.
  - `manual/` developer utilities and CLI flows.
- `e2e/` Playwright tests (e.g., `dealroom.spec.ts`).
- `functions/` Azure Functions packaging for `webhook` (JS + `function.json`).
- Build output: `dist/` (from `tsconfig.json`).

## Build, Test, Run
- Install: `npm ci`
- Type-check/build: `npm run build` (emits `dist/`)
- Local dev (CLI entry): `npm run dev` (runs `src/index.ts`)
  - Example: `npm run dev ./job.json` or `npm run dev '{"task_name":"Test"}'`
- Webhook server: `npm run webhook` (runs `src/webhook/server.ts`)
- Queue worker: `npm run worker`
- Start built server: `npm start` (uses `dist/src/webhook/server.js`)
- E2E tests: `npm run e2e:dealroom`

Environment
- Create `.env` (loaded via `dotenv`). Required for integrations:
  - SharePoint Graph: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`
  - Notion: `NOTION_TOKEN`
  - Optional: `LOG_LEVEL`, `KEEP_BROWSER_OPEN`, `USE_UNIVERSAL_DEFAULT`

## Coding Style & Naming
- Language: TypeScript (ES2022, `module` NodeNext). Indent 2 spaces.
- Files: lowerCamelCase (e.g., `detectPlatform.ts`, `fetchNdaUrl.ts`).
- Exports: prefer named exports; default allowed for singletons.
- Types first: add `types.ts` imports and Zod validation where applicable.
- Logging: use `src/util/logger.ts` (Winston). Avoid `console.*` in library code.

## Testing Guidelines
- Framework: Playwright. Config in `playwright.config.ts`.
- Location: `e2e/*.spec.ts`. Name tests descriptively (feature or flow based).
- Run headless CI by default; use traces and `acceptDownloads` when relevant.

## Commit & PR Guidelines
- Commits: concise, imperative mood; group logical changes.
- PRs: include description, test plan/steps, logs or screenshots, and any related issue links.
- Keep changes focused; avoid unrelated refactors. Update docs when behavior changes.

## Security & Configuration
- Never commit secrets. Use `.env` locally and secret managers in CI/CD.
- Validate inputs from webhooks and external sources before use.
