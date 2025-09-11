export type DealIngestionJob = {
  task_name: string;
  notion_page_id?: string;
  nda_url?: string;
  dealroom_url?: string;
  sharepoint_server_relative_path?: string; // e.g., /sites/ORHAcquisitions/Shared Documents/Folder
  email_body?: string;
};

// Minimal runtime validation shape used by the webhook.
export const DealIngestionJobKeys = [
  'task_name',
  'notion_page_id',
  'nda_url',
  'dealroom_url',
  'sharepoint_server_relative_path',
  'email_body'
] as const;
export type DealIngestionJobKey = typeof DealIngestionJobKeys[number];
