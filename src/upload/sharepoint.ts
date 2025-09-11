import { Client } from '@microsoft/microsoft-graph-client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream, statSync } from 'node:fs';
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

  const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    body: form
  });
  const json: any = await r.json();
  if (!r.ok) throw new Error(`Token error: ${r.status} ${JSON.stringify(json)}`);
  return json.access_token;
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
  const siteDrive = await client.api(`/sites/${hostname}:/${siteSegment}:/drive`).get();
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
        const di = await client
          .api(`/drives/${driveId}/root:/${encodeURI(destPath)}:/content`)
          .put(createReadStream(filePath));
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
        await uploadLargeFile(session.uploadUrl, filePath);
        const di = await client.api(`/drives/${driveId}/root:/${encodeURI(destPath)}`).get();
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
      await client.api(`/drives/${driveId}/root:/${encodeURI(p)}`).get();
    } catch {
      // Create folder at this level
      const parent = accumulated.slice(0, -1).join('/');
      const endpoint = parent
        ? `/drives/${driveId}/root:/${encodeURI(parent)}:/children`
        : `/drives/${driveId}/root/children`;
      await client.api(endpoint).post({ name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' });
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


async function uploadLargeFile(uploadUrl: string, filePath: string, chunkSize = 5 * 1024 * 1024) {
  const size = statSync(filePath).size;
  const stream = createReadStream(filePath);
  const chunks: Buffer[] = [];
  
  // Read the entire file into memory in chunks
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  
  const fileBuffer = Buffer.concat(chunks);
  let start = 0;
  
  while (start < size) {
    const end = Math.min(start + chunkSize, size) - 1;
    const chunk = fileBuffer.subarray(start, end + 1);
    
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': String(chunk.length),
        'Content-Type': mime.lookup(filePath) || 'application/octet-stream'
      },
      body: chunk
    });
    
    if (!response.ok && response.status !== 201 && response.status !== 200 && response.status !== 202) {
      const errorText = await response.text();
      throw new Error(`Chunk upload failed: ${response.status} ${errorText}`);
    }
    
    start = end + 1;
  }
}

