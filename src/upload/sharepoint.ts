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

export async function uploadFolderToSharePoint(
  localFolder: string, 
  sharepointFolderWebUrl?: string,
  sharepointFolderId?: string
) {
  const client = await graphClient();
  let driveId: string;
  let itemId: string;

  if (sharepointFolderId) {
    // Direct folder ID approach - much simpler!
    // Get site and drive info
    const site = await client.api('/sites/odysseyresidentialholdings.sharepoint.com:/sites/ORHAcquisitions').get();
    const drives = await client.api(`/sites/${site.id}/drives`).get();
    const sharedDocsDrive = drives.value.find((d: any) => d.name === 'Documents');
    if (!sharedDocsDrive) throw new Error('Could not find Documents drive');
    
    driveId = sharedDocsDrive.id;
    itemId = sharepointFolderId;
    
    // Verify the folder exists
    await client.api(`/drives/${driveId}/items/${itemId}`).get();
  } else if (sharepointFolderWebUrl) {
    // Legacy webUrl approach
    const target = await client.api('/shares')
      .query({ q: Buffer.from(sharepointFolderWebUrl).toString('base64url') })
      .get();

    const shareId = target?.value?.[0]?.id;
    if (!shareId) throw new Error('Could not resolve SharePoint folder from webUrl');

    const driveItem = await client.api(`/shares/${shareId}/driveItem`).get();
    driveId = driveItem.parentReference?.driveId;
    itemId = driveItem.id;
  } else {
    throw new Error('Must provide either sharepointFolderWebUrl or sharepointFolderId');
  }

  // Recurse the localFolder and upload
  for await (const filePath of walk(localFolder)) {
    const fileName = path.basename(filePath);
    const size = statSync(filePath).size;
    const rel = path.relative(localFolder, filePath).replace(/\\/g, '/');
    const destPath = rel; // preserve subfolder structure

    // Ensure subfolders exist
    await ensureFolders(client, driveId, itemId, path.dirname(destPath));

    if (size < 3.5 * 1024 * 1024) {
      await client.api(`/drives/${driveId}/items/${itemId}:/${destPath}:/content`)
        .put(createReadStream(filePath));
    } else {
      // Large file upload session
      const session = await client.api(`/drives/${driveId}/items/${itemId}:/${destPath}:/createUploadSession`)
        .post({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName }});
      await uploadLargeFile(session.uploadUrl, filePath);
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

async function ensureFolders(client: any, driveId: string, rootItemId: string, subpath: string) {
  if (!subpath || subpath === '.' ) return;
  const parts = subpath.split('/').filter(Boolean);
  let parentId = rootItemId;
  for (const part of parts) {
    // Try get
    try {
      const child = await client.api(`/drives/${driveId}/items/${parentId}/children/${encodeURIComponent(part)}`).get();
      parentId = child.id;
      continue;
    } catch {
      // create
      const newFolder = await client.api(`/drives/${driveId}/items/${parentId}/children`).post({
        name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'replace'
      });
      parentId = newFolder.id;
    }
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

