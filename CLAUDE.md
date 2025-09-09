# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm run dev [job.json]`: Run the application in development mode using tsx with optional job file
- `npm run build`: Compile TypeScript to JavaScript using tsc
- `npm start`: Run the compiled webhook server from dist/src/webhook/server.js
- `npm run webhook`: Run the webhook server in development mode
- `npx playwright install`: Install Playwright browser binaries (required for first setup)

## Architecture Overview

This is a Playwright-based deal ingestion system that automates downloading documents from various real estate data room platforms. The system follows a handler pattern architecture:

### Core Flow
1. **Job Input**: Takes a `DealIngestionJob` containing URLs, Notion page ID, SharePoint folder, etc.
2. **Platform Detection**: `detectPlatform()` analyzes URLs to determine which handler to use (buildout, crexi, rcm, or generic)
3. **Browser Session**: Creates persistent browser contexts with saved auth state per domain
4. **Document Download**: Platform-specific handlers automate NDA acceptance and document downloads
5. **Upload & Audit**: Uploads to SharePoint and creates audit trail with zipped artifacts

### Key Components

- **src/index.ts**: Main entry point and orchestration logic
- **src/detect/detectPlatform.ts**: URL pattern matching to determine platform type
- **src/handlers/**: Platform-specific automation logic (buildout.ts, crexi.ts, rcm.ts, generic.ts)
- **src/browser/session.ts**: Persistent auth state management using Playwright storageState
- **src/browser/download.ts**: Robust download utilities (`clickDownloadAll`, `enumerateFileLinks`)
- **src/upload/sharepoint.ts**: MS Graph API integration with large file upload support
- **src/audit/**: Audit logging and artifact zipping for compliance

### Handler Pattern
Each platform handler receives `(page, { job, workingDir, urls })` and returns a download directory path. Handlers follow a common pattern:
1. Navigate to platform URL
2. Handle NDA/confidentiality agreements
3. Attempt bulk download via "Download All" buttons
4. Fallback to individual file enumeration if bulk fails

### Authentication & State
- Browser sessions persist cookies/SSO state in `.auth/{domainKey}.json` files
- SharePoint uses client credentials flow with MS Graph API
- Notion integration for fetching NDA URLs from deal pages

### Environment Variables
The system expects environment variables for:
- `NOTION_TOKEN`: Notion API access
- `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`: MS Graph auth
- `STATE_DIR`: Override default `.auth` directory for browser state

### TypeScript & ESM
- Uses ES modules (`"type": "module"` in package.json)
- Import paths use `.js` extensions for compiled output
- Platform handlers use dynamic imports and type-only imports appropriately