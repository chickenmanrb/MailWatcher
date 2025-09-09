import 'dotenv/config';
import { QueueClient } from '@azure/storage-queue';
import { run } from '../index.js';
import type { DealIngestionJob } from '../types.js';

const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
const queueName = process.env.JOB_QUEUE_NAME || 'mailwatcher-jobs';
const visibilityTimeoutSec = 30; // time to process one job before it reappears

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
  while (true) {
    try {
      const resp = await queue.receiveMessages({ numberOfMessages: 1, visibilityTimeout: visibilityTimeoutSec });
      const msg = resp.receivedMessageItems?.[0];
      if (!msg) {
        await sleep(2000);
        continue;
      }

      const text = Buffer.from(msg.messageText, 'base64').toString('utf8');
      const job: DealIngestionJob = JSON.parse(text);
      console.log(`[worker] start ${job.task_name}`);
      try {
        await run(job);
        await queue.deleteMessage(msg.messageId, msg.popReceipt);
        console.log(`[worker] done ${job.task_name}`);
      } catch (err) {
        console.error('[worker] job error', err);
        // make message visible again later
        await queue.updateMessage(msg.messageId, msg.popReceipt, msg.messageText, { visibilityTimeout: 60 });
      }
    } catch (loopErr) {
      console.error('[worker] loop error', loopErr);
      await sleep(3000);
    }
  }
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

work().catch(err => { console.error(err); process.exit(1); });

