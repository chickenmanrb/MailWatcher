# Playwright Deal Agent

A Playwright-based automation that ingests deal room documents and uploads them to SharePoint.

## Quick Start

- Install: `npm ci`
- Run universal/manual Deal-to-Drive: `npm run manual:d2d -- --url="<dealroom_url>" --sprel="/sites/<SiteName>/Shared Documents/<FolderPath>"`

Examples:

- PowerShell:
  - `npm run manual:d2d -- --url="https://my.rcm1.com/buyer/vdr?pv=..." --sprel="/sites/ORHAcquisitions/Shared Documents/DOTM/2025/Project X"`
  - or escape `&`: `--url=https://my.rcm1.com/buyer/vdr?pv=...`&...`
- Bash:
  - `npm run manual:d2d -- --url='https://my.rcm1.com/buyer/vdr?pv=...' --sprel='/sites/ORHAcquisitions/Shared Documents/DOTM/2025/Project X'`

You can pass args as `--key=value` or `--key value`.

## Required Arguments

- `--url` Deal room entry URL
- `--sprel` Server-relative SharePoint folder path

Environment variable alternatives:

- `DEALROOM_URL`, `SHAREPOINT_SERVER_RELATIVE_PATH`, `SP_HOSTNAME`

## Notes on Downloads

- Files are consolidated under `runs/d2d-<host>-<timestamp>/downloads`.
- The browser may write to the OS Downloads folder during capture; the tool moves stabilized files to the job `downloads` folder.
- To override the watched OS downloads directory, set `RCM_DOWNLOAD_DIR` (defaults to `~/Downloads`).
- For SharePoint uploads via server-relative path, set `SP_HOSTNAME` (e.g., `contoso.sharepoint.com`).

## Other Scripts

- Type-check/build: `npm run build`
- Webhook server: `npm run webhook`
- Worker: `npm run worker` (local dev or fallback; prefer the Azure Functions queue trigger in production to avoid polling costs)
- Functions prep (build + copy dist): `npm run func:prep`
- E2E dealroom test: `npm run e2e:dealroom`

## Manual Testing

npx playwright codegen `<URL>`

## Manual Flows

Manual Flow Syntax

- Basic manual runner:
  - npm run manual -- --url="`<URL>`" [--rcm|--crexi|--buildout|--generic|--universal|--universal-dealroom] [--first=.. --last=.. --name=.. --email=.. --company=.. --title=.. --phone=..] [--task=..]
  - Alternative handler flag: --platform=rcm|crexi|buildout|generic|universal|universal-dealroom
- Convenience scripts:
  - Universal: npm run manual:universal -- --url="`<URL>`"
  - Dealroom (universal-dealroom): npm run manual:dealroom -- --url="`<URL>`"
- Dealroom-to-SharePoint (D2D):
  - npm run manual:d2d -- --url="`<URL>`" --sprel="/sites/`<Site>`/Shared Documents/`<FolderPath>`"
- Env var alternative:
  - Bash: MANUAL_URL="`<URL>`" npm run manual -- --universal
  - PowerShell: $env:MANUAL_URL="`<URL>`"; npm run manual -- --universal
- Example:
  - npm run manual -- --url="https://example.com/form" --universal --email="me@acme.com" --first=Alice --last=Lee --company="Acme" --title="Analyst" --phone="555-111-2222"

## Azure Function Webhook

- Endpoint

  - `POST https://<your-func-app>.azurewebsites.net/api/webhook`
  - Optional secret header: `x-zapier-secret: <WEBHOOK_SECRET>`
- Payload (SharePoint destination)

  - Recommended: `sprel` (server-relative path): `/sites/<Site>/Shared Documents/<Folder>`
  - Also accepted: `sharepoint_folder_webUrl` or `sharepoint_folder_id`
  - The function enqueues a unified job with `sharepoint_server_relative_path` for the worker.
- Idempotency

  - The function computes a hash of `nda_url | dealroom_url | sprel | (x-message-id)` and skips duplicates seen within `IDEMP_HOURS` (default 6h).
  - Returns `202 { ok: true, enqueued: false, duplicate: true }` on duplicates.
  - Uses the Function App’s `AzureWebJobsStorage` to store markers (container `idempotency`).
- Logging and cost controls

  - Set `FUNCTION_DEBUG=false` (default) to avoid payload logging.
  - Set `FUNCTION_DEBUG=true` (or `DEBUG=true`) to enable minimal debug logs.
  - Keep App Insights sampling low and consider a daily data cap in Azure Portal to control ingestion costs.

## Worker Runtime Controls

- Headless/browser

  - `HEADLESS=true` (default) runs Playwright headless.
  - `KEEP_BROWSER_OPEN=true` forces visible browser and keeps it open after success or errors (for debugging only).
- Disable polling worker

  - `WORKER_DISABLED=true` cleanly exits the polling worker immediately. Use this in production after deploying the Azure Functions queue trigger to avoid idle polling costs. The queue-trigger Function processes jobs automatically when messages arrive.
- Job timeout

  - `JOB_MAX_MS` sets a hard max runtime per job (default 30 minutes). Jobs exceeding this throw `JobTimeoutExceeded` and clean up the browser.
- SharePoint / Graph

  - `SP_HOSTNAME` (e.g., `contoso.sharepoint.com`)
  - `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`
- JLL-specific (optional)

  - `JLL_USERNAME`/`JLL_EMAIL`, `JLL_PASSWORD`
  - `JLL_ESIGN_NAME`, `JLL_TITLE`, `JLL_COMPANY`

## JLL Flow

- Overview

  - Supports JLL deals that require login and an e‑sign CA step before entering the Deal Room and downloading documents.
  - The handler is variant‑aware (detects login page, CA/e‑sign UI, deal room) and uses robust fallbacks.
- Environment

  - Credentials: set `JLL_USERNAME` or `JLL_EMAIL`, and `JLL_PASSWORD`.
  - E-sign fields (optional): `JLL_ESIGN_NAME`, `JLL_TITLE`, `JLL_COMPANY`.
  - Optional flags: `JLL_SKIP_LOGIN=true`, `JLL_SKIP_ESIGN=true`.
  
## Stagehand Fallback

- Purpose: targeted AI assist when deterministic selectors fail, gated per-domain.
- Config: edit `src/config/stagehandFallback.ts` to enable hosts and set budgets.
- Env: set `STAGEHAND_GLOBAL_DISABLE=false` (kill switch), `STAGEHAND_ENV`, `STAGEHAND_VERBOSE`, `STAGEHAND_ENABLE_CACHE`, and provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
- Usage: handlers call `fillFieldSmart`/`clickSubmitSmart` only after deterministic attempts miss; artifacts saved under `runs/<task>/stagehand/`.
- Audit: `stagehand-stats.json` is included in the job audit when present.

## Azure Cost/Resilience Improvements

- Queue worker
  - Batches messages per receive and uses adaptive backoff when queue is empty to reduce Storage Queue transactions.
  - Tunables: `QUEUE_RECEIVE_BATCH` (default 16), `QUEUE_VISIBILITY_TIMEOUT_SEC` (default 60).
- SharePoint (Graph) uploads
  - Large files stream in fixed-size chunks (no full-file buffering); final chunk response is used to avoid an extra GET.
  - Token fetch and chunk uploads have retry with backoff (429/5xx respect `Retry-After`).
  - Tunable chunk size: `GRAPH_UPLOAD_CHUNK_MB` (default 5 MB).
- Webhook idempotency
  - Azure Blob marker per job (container `idempotency`) prevents duplicate enqueues.
  - TTL metadata (`expiresAt`) set using `IDEMP_HOURS` (default 6h).
  - Purge utility: `npm run purge:idemp` (see below).

### Queue Trigger (serverless, event‑driven)

- Status: Implemented via `functions/queueRunner`.
- Rationale: replaces the polling worker with an Azure Functions Queue Trigger so execution is event‑driven (no idle polling transactions).
- How it works: the Function binds to the same queue (`mailwatcher-jobs`) and invokes the existing `run(job)` pipeline.
- Example (already in repo at `functions/queueRunner`):

  function.json
  {
    "bindings": [
      { "type": "queueTrigger", "direction": "in", "name": "queueItem", "queueName": "mailwatcher-jobs", "connection": "AzureWebJobsStorage" },
      { "type": "http", "direction": "out", "name": "res" }
    ]
  }

  index.js
  module.exports = async function (context, queueItem) {
    try {
      // If deploying compiled artifacts, import from dist
      const mod = await import('../../dist/src/index.js'); // ESM dynamic import
      const run = mod.run || mod.default?.run;
      if (!run) throw new Error('run() not found');
      await run(queueItem);
      context.log('[queueRunner] done', queueItem && queueItem.task_name);
    } catch (err) {
      context.log.error('[queueRunner] error', err && (err.stack || err.message) || String(err));
      // Let the platform retry according to Function settings
      throw err;
    }
  }

- Deployment notes:
  - Ensure `dist/` is built and published with the Function App, or inline the required logic into the Function.
  - Configure the same env vars used by the worker (`GRAPH_*`, `SP_HOSTNAME`, etc.).
  - Cutover: once the trigger is deployed, stop/disable the polling worker process to avoid idle queue polling charges and split consumption. Multiple consumers won't double‑process a single message (visibility timeout), but running both is unnecessary and incurs cost. Set `WORKER_DISABLED=true` if the worker might run in the same environment.

## Deploy (Azure Functions)

- Build artifacts
  - `npm run build` at repo root to generate `dist/`.
  - Or run: `npm run func:prep` (builds and copies `dist/` to `functions/dist`).
- Publish the Function App
  - From `functions/`: `func azure functionapp publish <YOUR_FUNCTION_APP_NAME>`.
  - This deploys both `functions/webhook` and `functions/queueRunner`.
- Configure app settings (Azure Portal or CLI)
  - Storage: `AzureWebJobsStorage` (usually auto‑configured by Azure).
  - Graph/SharePoint: `SP_HOSTNAME`, `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`.
  - Optional: `WEBHOOK_SECRET`, `JOB_MAX_MS`, Stagehand envs.
  - Ensure `KEEP_BROWSER_OPEN` is not set in production.
- Cutover from the polling worker
  - Stop the legacy process (PM2/systemd/Docker) or set `WORKER_DISABLED=true` to make the worker exit immediately.
  - The queue trigger will now process jobs automatically as messages arrive on `mailwatcher-jobs`.
- Local testing (Functions Core Tools)
  - `npm run func:prep && cd functions && func start`
  - POST to `http://localhost:7071/api/webhook` with your payload; the queue trigger will fire locally.

### Idempotency purge utility

- Command: `npm run purge:idemp -- --dry-run=true --container=idempotency --older-than-hours=24 --include-missing=false`
- Flags:
  - `--dry-run` Preview deletions (default true)
  - `--container` Blob container (default `idempotency`)
  - `--older-than-hours` Delete blobs older than this if metadata is missing (optional)
  - `--include-missing` Include blobs without `expiresAt` metadata when used with `--older-than-hours` (default false)

## Session Summary (What’s New)

- Targeted Stagehand fallback
  - Deterministic-first, per-domain gated; helpers: `fillFieldSmart`, `clickSubmitSmart`.
  - Integrated into Generic, JLL, RCM, Buildout, Crexi, and Universal flows.
  - Per-run budget and artifacts; audit merged via `stagehand-stats.json`.
- Universal and handlers
  - Added submit/navigation fallbacks for Buildout, Crexi, and Universal to overcome sticky flows.
- Domain config
  - Enabled: `invest.jll.com`, `rcm1.com`, `my.rcm1.com`, `buildout.com`, `crexi.com`, and variants.
  - Added Datasite and Intralinks (enabled with tuned budgets/timeouts).
- Azure optimizations
  - Queue worker batching and adaptive backoff to lower idle transaction costs.
  - Graph uploads stream large files and avoid extra `GET` on completion; retries added for token and chunk PUTs.
  - Webhook idempotency via Blob markers prevents duplicate work; purge tool included.
- Manual run

  - `npm run manual:jll -- --url="https://invest.jll.com/us/en/listings/.../esign-ca"`
  - Also accepts listing URLs; the handler completes login/e‑sign, navigates to `/deal-room`, checks consent, and downloads.
- Behavior

  - Artifacts: screenshots in `runs/<task>/jll-*.png`, downloads in `runs/<task>/downloads`.
  - Download capture monitors both the Playwright context downloads directory and the OS Downloads folder (`RCM_DOWNLOAD_DIR` overrides OS default).
- Auto-detection

  - When running via the main job flow, links containing `invest.jll.com` or `login.jll.com` are routed to the JLL handler automatically.

## Queue Purge

I added a one‑liner you can run locally to purge the queue.

- Command
  - AZURE_STORAGE_CONNECTION_STRING="<same as Function’s AzureWebJobsStorage>" npm run queue:clear
  - Uses JOB_QUEUE_NAME or defaults to mailwatcher-jobs.
- Script details
  - File: scripts/clearQueue.ts
  - Calls QueueClient.clearMessages() and prints approximate message count before/after.
- Alternatives
  - Storage Explorer: open your storage account → Queues → mailwatcher-jobs → “Clear Messages”.
  - Azure CLI:
    - az storage message clear --queue-name mailwatcher-jobs --account-name `<acct>` --auth-mode login (or use a connection string/env)
- 

You’re on PowerShell, but you used Bash-style env assignment. Also, your connection string looks malformed (starts with “https;…”). Use the exact connection string from Azure (usually starts with DefaultEndpointsProtocol=https; …) and set env vars via $env:.

  PowerShell (one-liner)

- $env:AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=<name>;AccountKey=<key>;EndpointSuffix=core.windows.net'; $env:JOB_QUEUE_NAME='mailwatcher-jobs'; npm run queue:clear

  Or set once per session, then run

- $env:AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=`<name>`;AccountKey=`<key>`;EndpointSuffix=core.windows.net'
- $env:JOB_QUEUE_NAME='mailwatcher-jobs'
- npm run queue:clear

  Or via .env (recommended for convenience)

- In the repo root, add/update .env:
  - AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=`<name>`;AccountKey=`<key>`;EndpointSuffix=core.windows.net
  - JOB_QUEUE_NAME=mailwatcher-jobs
- Then run: npm run queue:clear

  What you should see

- [queue:clear] Queue: mailwatcher-jobs (before: X)
- [queue:clear] Cleared. (after: 0)

  Important: you pasted a real Storage Account key in your last message. Rotate that key in Azure Portal immediately (Storage account → Security + networking → Access keys → Regenerate) and update the connection string wherever it’s used (Function App’s AzureWebJobsStorage, local .env).



You’re on PowerShell, but you used Bash-style env assignment. Also, your connection string looks malformed (starts with “https;…”). Use the exact connection string from Azure (usually starts with DefaultEndpointsProtocol=https; …) and set env vars via $env:.

  PowerShell (one-liner)

- $env:AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=<name>;AccountKey=<key>;EndpointSuffix=core.windows.net'; $env:JOB_QUEUE_NAME='mailwatcher-jobs'; npm run queue:clear

  Or set once per session, then run

- $env:AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=`<name>`;AccountKey=`<key>`;EndpointSuffix=core.windows.net'
- $env:JOB_QUEUE_NAME='mailwatcher-jobs'
- npm run queue:clear

  Or via .env (recommended for convenience)

- In the repo root, add/update .env:
  - AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=`<name>`;AccountKey=`<key>`;EndpointSuffix=core.windows.net
  - JOB_QUEUE_NAME=mailwatcher-jobs
- Then run: npm run queue:clear

  What you should see

- [queue:clear] Queue: mailwatcher-jobs (before: X)
- [queue:clear] Cleared. (after: 0)

  Important: you pasted a real Storage Account key in your last message. Rotate that key in Azure Portal immediately (Storage account → Security + networking → Access keys → Regenerate) and update the connection string wherever it’s used (Function App’s AzureWebJobsStorage, local .env).

You’re on PowerShell, but you used Bash-style env assignment. Also, your connection string looks malformed (starts with “https;…”). Use the exact connection string from Azure (usually starts with DefaultEndpointsProtocol=https; …) and set env vars via $env:.

  PowerShell (one-liner)

- $env:AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=<name>;AccountKey=<key>;EndpointSuffix=core.windows.net'; $env:JOB_QUEUE_NAME='mailwatcher-jobs'; npm run queue:clear

  Or set once per session, then run

- $env:AZURE_STORAGE_CONNECTION_STRING='DefaultEndpointsProtocol=https;AccountName=`<name>`;AccountKey=`<key>`;EndpointSuffix=core.windows.net'
- $env:JOB_QUEUE_NAME='mailwatcher-jobs'
- npm run queue:clear

  Or via .env (recommended for convenience)

- In the repo root, add/update .env:
  - AZURE_STORAGE_CONNECTION_STRING=DefaultEndpointsProtocol=https;AccountName=`<name>`;AccountKey=`<key>`;EndpointSuffix=core.windows.net
  - JOB_QUEUE_NAME=mailwatcher-jobs
- Then run: npm run queue:clear

  What you should see

- [queue:clear] Queue: mailwatcher-jobs (before: X)
- [queue:clear] Cleared. (after: 0)

  Important: you pasted a real Storage Account key in your last message. Rotate that key in Azure Portal immediately (Storage account → Security + networking → Access keys → Regenerate) and update the connection string wherever it’s used (Function App’s AzureWebJobsStorage, local .env).
