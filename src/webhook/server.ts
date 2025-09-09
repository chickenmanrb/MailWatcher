import http from 'node:http';
import { URL } from 'node:url';
import { run } from '../index.js';
import type { DealIngestionJob } from '../types.js';

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.WEBHOOK_SECRET || '';

// Very small in-memory queue to avoid overlapping Playwright runs
const queue: DealIngestionJob[] = [];
let processing = false;

function enqueue(job: DealIngestionJob) {
  queue.push(job);
  if (!processing) void drain();
}

async function drain() {
  processing = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      console.log(`[webhook] start job ${job.task_name}`);
      await run(job);
      console.log(`[webhook] done job ${job.task_name}`);
    } catch (err) {
      console.error('[webhook] job error', err);
    }
  }
  processing = false;
}

function parseJson(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error('payload too large'));
      }
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function ok(res: http.ServerResponse, code = 200, payload: any = { ok: true }) {
  const json = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(json);
}

function text(res: http.ServerResponse, code = 200, body = '') {
  res.writeHead(code, { 'content-type': 'text/plain' });
  res.end(body);
}

function bad(res: http.ServerResponse, code = 400, message = 'bad request') {
  ok(res, code, { ok: false, error: message });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    // Health
    if (req.method === 'GET' && url.pathname === '/health') {
      return text(res, 200, 'ok');
    }

    // Optional GET challenge passthrough (some providers use this)
    if (req.method === 'GET' && url.pathname === '/webhook') {
      const challenge = url.searchParams.get('validationToken') || url.searchParams.get('challenge');
      if (challenge) return text(res, 200, challenge);
      return text(res, 200, 'ready');
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      // Shared-secret check (set WEBHOOK_SECRET, configure Zapier header x-zapier-secret)
      if (SECRET) {
        const provided = req.headers['x-zapier-secret'];
        if (!provided || String(provided) !== SECRET) return bad(res, 401, 'unauthorized');
      }

      const data = await parseJson(req);

      // Map Zapier payload to DealIngestionJob
      const job: DealIngestionJob = {
        task_name: data.task_name || data.taskName || data.subject || 'zapier-job',
        notion_page_id: data.notion_page_id || data.notionPageId,
        nda_url: data.nda_url || data.ndaUrl,
        dealroom_url: data.dealroom_url || data.dealroomUrl,
        sharepoint_folder_webUrl: data.sharepoint_folder_webUrl || data.sharepointFolderUrl || data.sharepointFolderWebUrl,
        email_body: data.email_body || data.emailBody || data.body_html || data.body
      };

      // Minimal required field
      if (!job.sharepoint_folder_webUrl) return bad(res, 422, 'sharepoint_folder_webUrl required');

      // Enqueue and return fast
      enqueue(job);
      return ok(res, 202, { ok: true, enqueued: true });
    }

    bad(res, 404, 'not found');
  } catch (err: any) {
    console.error('[webhook] error', err);
    bad(res, 500, 'server error');
  }
});

server.listen(PORT, () => {
  console.log(`[webhook] listening on :${PORT}`);
});

