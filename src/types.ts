export type DealIngestionJob = {
  task_name: string;
  notion_page_id?: string;
  nda_url?: string;
  dealroom_url?: string;
  sharepoint_folder_webUrl?: string;  // Legacy support for existing URLs
  sharepoint_folder_id?: string;      // New: Direct SharePoint folder ID
  email_body?: string;
};

// Minimal runtime validation shape used by the webhook.
export const DealIngestionJobKeys = [
  'task_name',
  'notion_page_id',
  'nda_url',
  'dealroom_url',
  'sharepoint_folder_webUrl',
  'sharepoint_folder_id',
  'email_body'
] as const;
export type DealIngestionJobKey = typeof DealIngestionJobKeys[number];
