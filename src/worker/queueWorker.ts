import 'dotenv/config';
import { QueueClient } from '@azure/storage-queue';
import { run } from '../index.js';
import type { DealIngestionJob } from '../types.js';

// Optional kill-switch to prefer Azure Functions queue trigger in production
if (String(process.env.WORKER_DISABLED || '').toLowerCase() === 'true' || process.env.WORKER_DISABLED === '1') {
  console.log('[worker] disabled via WORKER_DISABLED. Exiting.');
  process.exit(0);
}

const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
const queueName = process.env.JOB_QUEUE_NAME || 'mailwatcher-jobs';
const visibilityTimeoutSec = Number(process.env.QUEUE_VISIBILITY_TIMEOUT_SEC || 60);
const maxBatch = Math.min(Math.max(Number(process.env.QUEUE_RECEIVE_BATCH || 16), 1), 32);

if (!conn) {
  console.error('Missing AZURE_STORAGE_CONNECTION_STRING');
  process.exit(1);
}

const queue = new QueueClient(conn, queueName);

async function ensureQueue() {
  try { await queue.createIfNotExists(); } catch {}
}

async function work() {
  await ensureQueue();
  console.log(`[worker] watching queue '${queueName}'`);
  let backoffMs = 2000;
  const maxBackoffMs = 30_000;
  while (true) {
    try {
      const resp = await queue.receiveMessages({ numberOfMessages: maxBatch, visibilityTimeout: visibilityTimeoutSec });
      const msgs = resp.receivedMessageItems || [];
      if (!msgs.length) {
        // adaptive backoff on empty
        await sleep(backoffMs + Math.floor(Math.random() * 500));
        backoffMs = Math.min(Math.floor(backoffMs * 1.7), maxBackoffMs);
        continue;
      }
      // reset backoff on work
      backoffMs = 2000;

      for (const msg of msgs) {
        let text = msg.messageText || '';
        if (text && text.trim().startsWith('{')) {
          // Already decoded JSON
        } else {
          try { text = Buffer.from(text, 'base64').toString('utf8'); } catch {}
        }
        const job: DealIngestionJob = JSON.parse(text);
        console.log(`[worker] start ${job.task_name}`);
        try {
          await run(job);
          await queue.deleteMessage(msg.messageId, msg.popReceipt);
          console.log(`[worker] done ${job.task_name}`);
        } catch (err) {
          console.error('[worker] job error', err);
          // make message visible again later
          try {
            await queue.updateMessage(msg.messageId, msg.popReceipt, msg.messageText, visibilityTimeoutSec);
          } catch (e) {
            console.error('[worker] updateMessage error', e);
          }
        }
      }
    } catch (loopErr) {
      console.error('[worker] loop error', loopErr);
      await sleep(3000);
    }
  }
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

work().catch(err => { console.error(err); process.exit(1); });
