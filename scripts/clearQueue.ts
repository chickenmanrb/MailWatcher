import 'dotenv/config';
import { QueueClient } from '@azure/storage-queue';

async function main() {
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  const queueName = process.env.JOB_QUEUE_NAME || 'mailwatcher-jobs';

  if (!conn) {
    console.error('[queue:clear] Missing AZURE_STORAGE_CONNECTION_STRING (or AzureWebJobsStorage)');
    process.exit(1);
  }

  const queue = new QueueClient(conn, queueName);
  try {
    await queue.createIfNotExists();
  } catch {}

  const before = await queue.getProperties().catch(() => undefined) as any;
  const beforeCount = before?.approximateMessagesCount ?? 'unknown';
  console.log(`[queue:clear] Queue: ${queueName} (before: ${beforeCount})`);

  await queue.clearMessages();

  const after = await queue.getProperties().catch(() => undefined) as any;
  const afterCount = after?.approximateMessagesCount ?? 'unknown';
  console.log(`[queue:clear] Cleared. (after: ${afterCount})`);
}

main().catch(err => { console.error('[queue:clear] error:', err?.message || err); process.exit(1); });

