module.exports = async function (context, req) {
  // 1) Graph validation handshake (must echo within ~10s)
  const token = req.query.validationToken || req.query.validationtoken;
  if (token) {
    context.res = {
      status: 200,
      headers: { "Content-Type": "text/plain" },
      body: token
    };
    return;
  }

  // 2) Normal notifications (POST)
  const body = req.body || {};
  const notifications = Array.isArray(body.value) ? body.value : [];
  context.log(`Received ${notifications.length} notification(s)`);
  // TODO: fetch message via Graph, filter sender(s), forward to processing function

  context.res = { status: 202 };
};