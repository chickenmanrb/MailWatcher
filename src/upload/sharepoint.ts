import { Client } from '@microsoft/microsoft-graph-client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, statSync } from 'node:fs';
import fsnode from 'node:fs/promises';
import mime from 'mime-types';

async function graphClient() {
  const tenant = process.env.GRAPH_TENANT_ID!;
  const clientId = process.env.GRAPH_CLIENT_ID!;
  const secret = process.env.GRAPH_CLIENT_SECRET!;

  const token = await clientCredentialsToken(tenant, clientId, secret);
  return Client.init({
    authProvider: done => done(null, token)
  });
}

async function clientCredentialsToken(tenant: string, clientId: string, secret: string): Promise<string> {
  const form = new URLSearchParams();
  form.set('client_id', clientId);
  form.set('client_secret', secret);
  form.set('scope', 'https://graph.microsoft.com/.default');
  form.set('grant_type', 'client_credentials');

  const r = await fetchWithRetry(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    body: form
  }, 4);
  const json: any = await r.json();
  if (!r.ok) throw new Error(`Token error: ${r.status} ${JSON.stringify(json)}`);
  return json.access_token;
}

async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 5): Promise<Response> {
  let attempt = 0;
  let lastErr: any;
  while (attempt <= maxRetries) {
    try {
      const resp = await fetch(url, init);
      if (resp.ok || resp.status === 200 || resp.status === 201 || resp.status === 202) return resp;
      // Retry on 429/5xx
      if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
        const ra = Number(resp.headers.get('retry-after'));
        const base = Number.isFinite(ra) ? ra * 1000 : Math.min(1000 * Math.pow(2, attempt), 8000);
        await new Promise(res => setTimeout(res, base + Math.floor(Math.random() * 250)));
        attempt++;
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      await new Promise(res => setTimeout(res, Math.min(1000 * Math.pow(2, attempt), 8000)));
      attempt++;
    }
  }
  throw lastErr || new Error('fetchWithRetry failed');
}


/**
 * Approach A: Upload to a SharePoint folder by server-relative path
 * Example serverRelativePath:
 *   /sites/ORHAcquisitions/Shared Documents/DOTM/2025/Some Folder
 * Requires env: SP_HOSTNAME (e.g., odysseyresidentialholdings.sharepoint.com)
 */
export async function uploadFolderToSharePointByPath(
  localFolder: string,
  serverRelativePath: string,
  auditDir?: string
): Promise<Array<{ localPath: string; bytes: number; destPath: string; itemId: string; webUrl?: string }>> {
  const hostname = process.env.SP_HOSTNAME || process.env.SHAREPOINT_HOSTNAME || process.env.GRAPH_HOSTNAME;
  if (!hostname) {
    throw new Error('Missing SP_HOSTNAME. Set your SharePoint hostname, e.g. SP_HOSTNAME=contoso.sharepoint.com');
  }

  const client = await graphClient();

  // Normalize and split the server-relative path
  const norm = serverRelativePath.replace(/^\/+/, '').replace(/\\/g, '/'); // remove leading '/', normalize slashes
  const parts = norm.split('/');
  if (parts.length < 2 || parts[0] !== 'sites') {
    throw new Error(`Invalid serverRelativePath. Expected "/sites/<SiteName>/Shared Documents/...", got: ${serverRelativePath}`);
  }
  const siteSegment = `sites/${parts[1]}`; // e.g., sites/ORHAcquisitions
  // Library-relative folder path: strip first two segments (sites, <SiteName>)
  const libraryPath = parts.slice(2).join('/'); // e.g., Shared Documents/DOTM/2025/...

  // Resolve the default Documents drive for the site
  const siteDrive = await graphGet(client, `/sites/${hostname}:/${siteSegment}:/drive`);
  const driveId = siteDrive?.id as string;
  if (!driveId) throw new Error('Could not resolve site driveId');

  // Compute target folder path relative to the drive root
  // Remove the library root label if present (Shared Documents or Documents)
  let folderRel = libraryPath.replace(/^Shared Documents\/?/i, '').replace(/^Documents\/?/i, '').replace(/^\/+/, '');
  // Trim trailing slash
  folderRel = folderRel.replace(/\/$/, '');

  // Ensure the target folder exists
  await ensureFolderPathByRoot(client, driveId, folderRel);

  const receipts: Array<{ localPath: string; bytes: number; destPath: string; itemId: string; webUrl?: string }> = [];
  console.log('[sp] upload start (by path):', { localFolder, hostname, siteSegment, driveId, folderRel });

  for await (const filePath of walk(localFolder)) {
    const fileName = path.basename(filePath);
    const size = statSync(filePath).size;
    const rel = path.relative(localFolder, filePath).replace(/\\/g, '/');
    const destPath = [folderRel, rel].filter(Boolean).join('/');

    try {
      if (size < 3.5 * 1024 * 1024) {
        const di = await graphPutStream(client, `/drives/${driveId}/root:/${encodeURI(destPath)}:/content`, createReadStream(filePath));
        const receipt = {
          localPath: filePath,
          bytes: size,
          destPath,
          itemId: di?.id as string,
          webUrl: di?.webUrl as string | undefined
        };
        receipts.push(receipt);
        console.log('[sp] uploaded (small):', receipt.destPath, '->', receipt.webUrl || receipt.itemId);
      } else {
        const session = await client
          .api(`/drives/${driveId}/root:/${encodeURI(destPath)}:/createUploadSession`)
          .post({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName } });
        const chunkMb = Number(process.env.GRAPH_UPLOAD_CHUNK_MB || 5);
        const driveItemFromUpload = await uploadLargeFile(session.uploadUrl, filePath, Math.max(1, chunkMb) * 1024 * 1024);
        const di = driveItemFromUpload || await graphGet(client, `/drives/${driveId}/root:/${encodeURI(destPath)}`);
        const receipt = {
          localPath: filePath,
          bytes: size,
          destPath,
          itemId: di?.id as string,
          webUrl: di?.webUrl as string | undefined
        };
        receipts.push(receipt);
        console.log('[sp] uploaded (large):', receipt.destPath, '->', receipt.webUrl || receipt.itemId);
      }
    } catch (e: any) {
      console.error('[sp] upload error for', destPath, e?.message || e);
      throw e;
    }
  }

  if (auditDir) {
    try {
      await fs.mkdir(auditDir, { recursive: true });
      const p = path.join(auditDir, 'upload-receipt.json');
      await fs.writeFile(p, JSON.stringify({ driveId, folderRel, files: receipts }, null, 2), 'utf8');
      console.log('[sp] wrote receipt:', p);
    } catch (e) {
      console.warn('[sp] could not write receipt:', (e as any)?.message || e);
    }
  }
  return receipts;
}

async function ensureFolderPathByRoot(client: any, driveId: string, folderRel: string) {
  if (!folderRel) return; // uploading to root
  const parts = folderRel.split('/').filter(Boolean);
  let accumulated: string[] = [];
  for (const part of parts) {
    accumulated.push(part);
    const p = accumulated.join('/');
    // Try GET the folder
    try {
      await graphGet(client, `/drives/${driveId}/root:/${encodeURI(p)}`);
    } catch {
      // Create folder at this level
      const parent = accumulated.slice(0, -1).join('/');
      const endpoint = parent
        ? `/drives/${driveId}/root:/${encodeURI(parent)}:/children`
        : `/drives/${driveId}/root/children`;
      await graphPost(client, endpoint, { name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' });
    }
  }
}



async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}


async function uploadLargeFile(uploadUrl: string, filePath: string, chunkSize = 5 * 1024 * 1024): Promise<any | null> {
  const size = statSync(filePath).size;
  const fh = await fsnode.open(filePath, 'r');
  try {
    let start = 0;
    let lastResp: Response | null = null;
    const contentType = (mime.lookup(filePath) || 'application/octet-stream') as string;
    while (start < size) {
      const end = Math.min(start + chunkSize, size) - 1;
      const len = end - start + 1;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      const body = bytesRead === len ? buf : buf.subarray(0, bytesRead);
      const resp = await fetchWithRetry(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(body.length),
          'Content-Type': contentType
        },
        body
      }, 6);
      lastResp = resp;
      if (!(resp.ok || resp.status === 200 || resp.status === 201 || resp.status === 202)) {
        const errorText = await resp.text();
        throw new Error(`Chunk upload failed: ${resp.status} ${errorText}`);
      }
      start = end + 1;
    }
    if (lastResp) {
      const ct = lastResp.headers.get('content-type') || '';
      if (ct.includes('json')) {
        try { return await lastResp.json(); } catch {}
      }
    }
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

function isRetryableStatus(status?: number) {
  return status === 429 || (typeof status === 'number' && status >= 500 && status < 600);
}

function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function graphGet(client: any, path: string, maxRetries = 4): Promise<any> {
  let attempt = 0; let lastErr: any;
  while (attempt <= maxRetries) {
    try { return await client.api(path).get(); }
    catch (e: any) {
      const sc = e?.statusCode || e?.status || e?.response?.status;
      if (isRetryableStatus(sc)) { await sleep(Math.min(1000 * Math.pow(2, attempt), 8000)); attempt++; lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('graphGet failed');
}

async function graphPost(client: any, path: string, body: any, maxRetries = 4): Promise<any> {
  let attempt = 0; let lastErr: any;
  while (attempt <= maxRetries) {
    try { return await client.api(path).post(body); }
    catch (e: any) {
      const sc = e?.statusCode || e?.status || e?.response?.status;
      if (isRetryableStatus(sc)) { await sleep(Math.min(1000 * Math.pow(2, attempt), 8000)); attempt++; lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('graphPost failed');
}

async function graphPutStream(client: any, path: string, stream: NodeJS.ReadableStream, maxRetries = 4): Promise<any> {
  let attempt = 0; let lastErr: any;
  while (attempt <= maxRetries) {
    try { return await client.api(path).put(stream as any); }
    catch (e: any) {
      const sc = e?.statusCode || e?.status || e?.response?.status;
      if (isRetryableStatus(sc)) { await sleep(Math.min(1000 * Math.pow(2, attempt), 8000)); attempt++; lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('graphPutStream failed');
}

