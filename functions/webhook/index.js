const { BlobServiceClient } = require('@azure/storage-blob');
const crypto = require('crypto');

async function ensureIdempotentMarker(connectionString, key, ttlHours) {
  const svc = BlobServiceClient.fromConnectionString(connectionString);
  const container = svc.getContainerClient('idempotency');
  await container.createIfNotExists({ access: 'private' }).catch(() => {});
  const blob = container.getBlockBlobClient(key);
  // Try to create the blob only if it does not exist
  const metadata = ttlHours ? { expiresAt: String(Date.now() + ttlHours * 3600 * 1000) } : undefined;
  try {
    await blob.upload('', 0, { conditions: { ifNoneMatch: '*' }, metadata });
    return { created: true };
  } catch (e) {
    // If-None-Match failed: already exists
    return { created: false };
  }
}

module.exports = async function (context, req) {
  try {
    // Health and challenge echo
    const validationToken = req.query && (req.query.validationToken || req.query.challenge);
    if (req.method === 'GET') {
      context.res = { status: 200, headers: { 'content-type': 'text/plain' }, body: validationToken || 'ready' };
      return;
    }

    // Secret check (Zapier header)
    const expected = process.env.WEBHOOK_SECRET || '';
    if (expected) {
      const provided = (req.headers && (req.headers['x-zapier-secret'] || req.headers['X-Zapier-Secret'])) || '';
      if (String(provided) !== String(expected)) {
        context.log.warn('unauthorized webhook request');
        context.res = { status: 401, headers: { 'content-type': 'application/json' }, body: { ok: false, error: 'unauthorized' } };
        return;
      }
    }

    let data = req.body || {};
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch {}
    }
    if (Array.isArray(data)) data = data[0] || {};
    // Minimal validation: require SharePoint server-relative path
    const sp = data.sharepoint || {};
    const spRel = data.sprel || data.sharepoint_server_relative_path || sp.server_relative_path || sp.serverRelativePath || data.sharepointFolderPath;
    if (!spRel) {
      context.res = { status: 422, headers: { 'content-type': 'application/json' }, body: { ok: false, error: 'sharepoint server-relative path required', keys: Object.keys(data || {}), nestedSharepointKeys: Object.keys(sp || {}) } };
      return;
    }

    context.log('webhook payload', JSON.stringify(data).slice(0, 2000));

    // Build job
    const job = {
      task_name: data.task_name || data.taskName || data.subject || 'zapier-job',
      notion_page_id: data.notion_page_id || data.notionPageId,
      nda_url: data.nda_link || data.nda_url || data.ndaUrl,
      dealroom_url: data.dealroom_link || data.dealroom_url || data.dealroomUrl,
      sharepoint_server_relative_path: spRel,
      email_body: data.email_body || data.emailBody || data.body_html || data.body
    };

    // Idempotency: derive a stable key and create a marker blob if one does not exist.
    try {
      const base = [job.nda_url || '', job.dealroom_url || '', job.sharepoint_server_relative_path || '', data['x-message-id'] || data['message_id'] || ''].join('|');
      const key = crypto.createHash('sha256').update(base).digest('hex');
      const conn = process.env.AzureWebJobsStorage || process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (conn) {
        const res = await ensureIdempotentMarker(conn, key, Number(process.env.IDEMP_HOURS || 6));
        if (!res.created) {
          context.res = { status: 202, headers: { 'content-type': 'application/json' }, body: { ok: true, enqueued: false, duplicate: true } };
          return;
        }
      } else {
        context.log.warn('No AzureWebJobsStorage available for idempotency; proceeding without dedupe');
      }
    } catch (e) {
      context.log.warn('idempotency marker error', e && e.message || String(e));
    }

    // Enqueue job to Azure Storage Queue via output binding
    context.bindings.job = JSON.stringify(job);
    context.res = { status: 202, headers: { 'content-type': 'application/json' }, body: { ok: true, enqueued: true } };
  } catch (err) {
    context.log.error('webhook error', err && err.stack || String(err));
    context.res = { status: 500, headers: { 'content-type': 'application/json' }, body: { ok: false, error: 'server error' } };
  }
};
