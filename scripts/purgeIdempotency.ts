import 'dotenv/config';
import { BlobServiceClient } from '@azure/storage-blob';

type Options = {
  container: string;
  dryRun: boolean;
  includeMissing: boolean;
  olderThanMs?: number;
};

function parseBool(v?: string) { return String(v || '').toLowerCase() === 'true'; }

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const i = args.findIndex(a => a === `--${k}` || a.startsWith(`--${k}=`));
    if (i === -1) return undefined;
    const v = args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
    return v;
  };
  const container = get('container') || 'idempotency';
  const dryRun = parseBool(get('dry-run') || process.env.DRY_RUN || 'true');
  const includeMissing = parseBool(get('include-missing') || process.env.INCLUDE_MISSING || 'false');
  const hours = get('older-than-hours');
  const olderThanMs = hours ? Number(hours) * 3600 * 1000 : undefined;
  return { container, dryRun, includeMissing, olderThanMs };
}

async function main() {
  const opts = parseArgs();
  const conn = process.env.AZURE_STORAGE_CONNECTION_STRING || process.env.AzureWebJobsStorage;
  if (!conn) {
    console.error('[purge:idemp] Missing AZURE_STORAGE_CONNECTION_STRING (or AzureWebJobsStorage)');
    process.exit(1);
  }
  const svc = BlobServiceClient.fromConnectionString(conn);
  const container = svc.getContainerClient(opts.container);
  await container.createIfNotExists({ access: 'private' }).catch(() => {});

  let deleted = 0, skipped = 0, total = 0;
  const now = Date.now();
  for await (const blob of container.listBlobsFlat({ includeMetadata: true })) {
    total++;
    const meta = blob.metadata || {} as any;
    const exp = meta.expiresAt ? Number(meta.expiresAt) : undefined;
    const hasMeta = typeof exp === 'number' && Number.isFinite(exp);
    let shouldDelete = false;
    if (hasMeta && exp < now) shouldDelete = true;
    else if (!hasMeta && opts.includeMissing && opts.olderThanMs) {
      // fall back to last modified timestamp if available
      const lastModified = blob.properties?.lastModified?.getTime?.() || 0;
      if (lastModified && (now - lastModified) > opts.olderThanMs) shouldDelete = true;
    }

    if (shouldDelete) {
      if (opts.dryRun) {
        console.log(`[purge:idemp] Would delete: ${blob.name}`);
      } else {
        await container.deleteBlob(blob.name).catch(e => console.warn('[purge:idemp] delete error', e?.message || e));
        console.log(`[purge:idemp] Deleted: ${blob.name}`);
        deleted++;
      }
    } else {
      skipped++;
    }
  }
  console.log(`[purge:idemp] Done. total=${total} deleted=${deleted} skipped=${skipped} dryRun=${opts.dryRun}`);
}

main().catch(err => { console.error('[purge:idemp] error:', err?.message || err); process.exit(1); });

