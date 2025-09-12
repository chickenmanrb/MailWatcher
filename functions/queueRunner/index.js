module.exports = async function (context, queueItem) {
  try {
    // Resolve compiled artifact path robustly for different deployment layouts.
    // Preferred: copy dist/ under the Function App root (next to webhook/queueRunner),
    // so from this function dir we can reach ../dist/src/index.js.
    // Fallback: if repo root is the Function App root, try ../../dist/src/index.js.
    const path = require('path');
    const { pathToFileURL } = require('url');
    const funcDir = (context.executionContext && context.executionContext.functionDirectory) || __dirname;
    const candidates = [
      path.resolve(funcDir, '..', 'dist', 'src', 'index.js'),
      path.resolve(funcDir, '..', '..', 'dist', 'src', 'index.js')
    ];

    let mod;
    let lastErr;
    for (const p of candidates) {
      try {
        mod = await import(pathToFileURL(p).href);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!mod) {
      throw new Error(`Unable to load dist module. Tried: ${candidates.join(', ')}. Last error: ${lastErr && (lastErr.stack || lastErr.message)}`);
    }

    const run = mod.run || (mod.default && mod.default.run);
    if (!run) throw new Error('run() not found in dist module');

    await run(queueItem);
    context.log('[queueRunner] done', queueItem && queueItem.task_name);
  } catch (err) {
    context.log.error('[queueRunner] error', (err && (err.stack || err.message)) || String(err));
    // Let the platform retry according to Function settings
    throw err;
  }
};
