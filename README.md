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
- Worker: `npm run worker`
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
  - E‑sign fields (optional): `JLL_ESIGN_NAME`, `JLL_TITLE`, `JLL_COMPANY`.
  - Optional flags: `JLL_SKIP_LOGIN=true`, `JLL_SKIP_ESIGN=true`.
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
