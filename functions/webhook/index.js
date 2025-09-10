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
    // Minimal validation: require SharePoint folder reference (webUrl or id)
    const sp = data.sharepoint || {};
    const spWebUrl = sp.drive_id || data['sharepoint.drive_id'] || data.sharepoint_folder_webUrl || data.sharepointFolderWebUrl || data.sharepointFolderUrl;
    const spId = sp.id || data.sharepoint_id;
    if (!spWebUrl && !spId) {
      context.res = { status: 422, headers: { 'content-type': 'application/json' }, body: { ok: false, error: 'sharepoint folder reference required', keys: Object.keys(data || {}), nestedSharepointKeys: Object.keys(sp || {}) } };
      return;
    }

    context.log('webhook payload', JSON.stringify(data).slice(0, 2000));

    // Enqueue job to Azure Storage Queue via output binding
    const job = {
      task_name: data.task_name || data.taskName || data.subject || 'zapier-job',
      notion_page_id: data.notion_page_id || data.notionPageId,
      nda_url: data.nda_link || data.nda_url || data.ndaUrl,
      dealroom_url: data.dealroom_link || data.dealroom_url || data.dealroomUrl,
      sharepoint_folder_webUrl: spWebUrl,
      sharepoint_folder_id: spId,
      email_body: data.email_body || data.emailBody || data.body_html || data.body
    };
    context.bindings.job = JSON.stringify(job);
    context.res = { status: 202, headers: { 'content-type': 'application/json' }, body: { ok: true, enqueued: true } };
  } catch (err) {
    context.log.error('webhook error', err && err.stack || String(err));
    context.res = { status: 500, headers: { 'content-type': 'application/json' }, body: { ok: false, error: 'server error' } };
  }
};
