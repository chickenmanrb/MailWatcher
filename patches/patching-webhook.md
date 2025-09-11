## Fixed Flow

webhook payload is supposed to start universal handler

- nda_url is the first stage in the flow, handler is supposed to try to execute the CA
- then handler should try to pursue the flow all the way to accessing the dealroom, downloading the files, and uploading to sharepoint


## Current Flow (wrong)

> Endpoints

- GET /health: returns ok.
- GET /webhook: echoes validationToken/challenge query param for provider verification, else ready.
- POST /webhook: accepts a job payload; optional auth via x-zapier-secret header equals WEBHOOK_SECRET.

  Auth & Validation
- If WEBHOOK_SECRET is set, requires header x-zapier-secret: `<secret>` or responds 401.
- Body max ~1MB; JSON only. Arrays allowed — uses the first element.
- Requires sharepoint_server_relative_path (or aliases below) or responds 422.

  Payload Mapping → Job
- task_name: task_name | taskName | subject (default zapier-job)
- notion_page_id: notion_page_id | notionPageId
- nda_url: nda_link | nda_url | ndaUrl
- dealroom_url: dealroom_link | dealroom_url | dealroomUrl
- sharepoint_server_relative_path: sprel | sharepoint_server_relative_path | sharepoint.server_relative_path | sharepoint.serverRelativePath | sharepointFolderPath
- email_body: email_body | emailBody | body_html | body

  Returns 202 { ok: true, enqueued: true } immediately after enqueue.

  Processing Pipeline (async, in-memory queue)
- Single-flight queue: jobs run one-at-a-time to avoid overlapping Playwright sessions.
- For each job, run(job):

  - Resolves nda_url from Notion if only notion_page_id given (needs NOTION_TOKEN).
  - Builds candidate URLs: NDA, deal room, plus links extracted from email_body.
  - Detects platform: buildout | crexi | rcm | jll | generic.
  - Launches Playwright (non-headless), creates a context with persisted storage at .auth/`<domainKey>`.json (cookies/SSO).
  - Runs the platform handler:
    - Buildout/Crexi/RCM/JLL: site-specific flows (JLL handles login + e‑sign variants).
    - Otherwise: universal if USE_UNIVERSAL_DEFAULT=true, else generic.
  - Downloads artifacts to runs/`<timestamp>`-`<task>`/downloads using robust monitors.
  - Uploads to SharePoint via Graph: uploadFolderToSharePointByPath(downloadedRoot, sharepoint_server_relative_path, workingDir) (requires GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET).
  - Writes audit receipt and zips artifacts.
  - Closes browser unless controlled by flags (see below).

  Response & Side Effects
- The POST returns 202 before processing finishes.
- Logs show [webhook] start job ... and ... done job ... when the job completes.
- Artifacts: runs/`<timestamp>`-`<task>`/..., zipped with logs/screenshots and upload receipts.

  Gotchas / Flags
- Error path currently keeps the browser open for inspection (hard-coded): the job will hang until manually closed. Consider changing that if running unattended.
- Set KEEP_BROWSER_OPEN=true to keep the browser open even on success (debugging).
- JLL flows need JLL_USERNAME/JLL_PASSWORD and optionally JLL_ESIGN_NAME, JLL_TITLE, JLL_COMPANY.
