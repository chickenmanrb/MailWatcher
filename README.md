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
