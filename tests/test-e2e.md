# E2E Testing Guide

## ✅ System is Now Ready for Testing!

The TypeScript compilation succeeded and all dependencies are installed.

## Test Commands

### 1. Test with minimal required parameters:
```bash
npm run dev '{"notion_page_id":"YOUR_NOTION_PAGE_ID","sharepoint_folder_webUrl":"YOUR_SHAREPOINT_URL","task_name":"test-run"}'
```

### 2. Test with direct URL (bypassing Notion):
```bash
npm run dev '{"notion_page_id":"","sharepoint_folder_webUrl":"YOUR_SHAREPOINT_URL","task_name":"test-run","dealroom_url":"YOUR_DEALROOM_URL"}'
```

### 3. Test with full parameters:
```bash
npm run dev '{
  "notion_page_id": "YOUR_NOTION_PAGE_ID",
  "sharepoint_folder_webUrl": "https://yourcompany.sharepoint.com/sites/deals/Shared%20Documents/TestDeal",
  "task_name": "test-deal-123",
  "dealroom_url": "https://app.buildout.com/website/123456",
  "email_body": "Check out this deal at https://app.crexi.com/properties/123456"
}'
```

## Required Environment Variables

Make sure your `.ENV` file has:
- `NOTION_TOKEN` - Your Notion API token
- `NOTION_DB_ID` - Your Notion database ID (optional)
- `GRAPH_TENANT_ID` - Azure AD tenant ID
- `GRAPH_CLIENT_ID` - Azure app client ID
- `GRAPH_CLIENT_SECRET` - Azure app client secret

## What to Expect

1. **Browser Launch**: Playwright will launch a headless Chromium browser
2. **Platform Detection**: System will identify the platform (Buildout, Crexi, RCM, or generic)
3. **Authentication**: Browser will use saved session state if available
4. **Document Download**: Handler will navigate, accept NDAs, and download documents
5. **SharePoint Upload**: Files will be uploaded to the specified SharePoint folder
6. **Audit Trail**: Creates audit log and zipped artifacts in `runs/` directory

## Debugging

- Set `LOG_LEVEL=debug` for verbose logging
- Check `runs/` directory for downloaded files and audit logs
- Browser sessions are saved in `.auth/` directory

## Common Issues

1. **Authentication**: First run may require manual login - the session will be saved
2. **SharePoint Access**: Ensure the Azure app has proper permissions
3. **Notion Access**: Verify the Notion token has access to the specified page