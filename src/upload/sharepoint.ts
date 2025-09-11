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
  sharepointFolderId?: string,
  auditDir?: string
): Promise<Array<{ localPath: string; bytes: number; destPath: string; itemId: string; webUrl?: string }>> {
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

  const receipts: Array<{ localPath: string; bytes: number; destPath: string; itemId: string; webUrl?: string }> = [];
  console.log('[sp] upload start:', { localFolder, driveId, itemId });

  // Recurse the localFolder and upload
  for await (const filePath of walk(localFolder)) {
    const fileName = path.basename(filePath);
    const size = statSync(filePath).size;
    const rel = path.relative(localFolder, filePath).replace(/\\/g, '/');
    const destPath = rel; // preserve subfolder structure

    // Ensure subfolders exist
    await ensureFolders(client, driveId, itemId, path.dirname(destPath));

    try {
      if (size < 3.5 * 1024 * 1024) {
        const di = await client.api(`/drives/${driveId}/items/${itemId}:/${destPath}:/content`)
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
      // Large file upload session
        const session = await client.api(`/drives/${driveId}/items/${itemId}:/${destPath}:/createUploadSession`)
          .post({ item: { '@microsoft.graph.conflictBehavior': 'replace', name: fileName }});
        await uploadLargeFile(session.uploadUrl, filePath);
        // Resolve the created/updated drive item to capture IDs/URL
        const di = await client.api(`/drives/${driveId}/items/${itemId}:/${destPath}`).get();
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

  // Write audit manifest if requested
  if (auditDir) {
    try {
      await fs.mkdir(auditDir, { recursive: true });
      const p = path.join(auditDir, 'upload-receipt.json');
      await fs.writeFile(p, JSON.stringify({ driveId, rootItemId: itemId, files: receipts }, null, 2), 'utf8');
      console.log('[sp] wrote receipt:', p);
    } catch (e) {
      console.warn('[sp] could not write receipt:', (e as any)?.message || e);
    }
  }
  return receipts;
}

function isGuid(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function resolveFolderFromWebUrl(sharepointFolderWebUrl: string): Promise<{ driveId: string; itemId: string; webUrl?: string }> {
  const client = await graphClient();
  const target = await client.api('/shares')
    .query({ q: Buffer.from(sharepointFolderWebUrl).toString('base64url') })
    .get();
  const shareId = target?.value?.[0]?.id;
  if (!shareId) throw new Error('Could not resolve SharePoint folder from webUrl');
  const driveItem = await client.api(`/shares/${shareId}/driveItem`).get();
  return { driveId: driveItem.parentReference?.driveId, itemId: driveItem.id, webUrl: driveItem.webUrl };
}

export async function resolveFolderId(idOrGuid: string): Promise<{ driveId: string; itemId: string; webUrl?: string }> {
  const client = await graphClient();
  const site = await client.api('/sites/odysseyresidentialholdings.sharepoint.com:/sites/ORHAcquisitions').get();
  const drives = await client.api(`/sites/${site.id}/drives`).get();
  let sharedDocsDrive = drives.value.find((d: any) => d.name === 'Documents');
  if (!sharedDocsDrive) sharedDocsDrive = drives.value.find((d: any) => d.name === 'Shared Documents');
  if (!sharedDocsDrive) sharedDocsDrive = drives.value.find((d: any) => (d?.driveType === 'documentLibrary'));
  if (!sharedDocsDrive) throw new Error('Could not find Documents drive');
  const driveId: string = sharedDocsDrive.id;

  if (isGuid(idOrGuid)) {
    // Resolve GUID UniqueId -> DriveItem id
    const listInfo = await client.api(`/drives/${driveId}/list`).get();
    const listId = listInfo.id;
    try {
      const resp = await client
        .api(`/sites/${site.id}/lists/${listId}/items`)
        .header('Prefer', 'HonorNonIndexedQueriesWarningMayFailRandomly=true')
        .header('ConsistencyLevel', 'eventual')
        .filter(`fields/UniqueId eq '${idOrGuid}'`)
        .expand('driveItem($select=id,webUrl,parentReference)')
        .select('id,fields')
        .get();
      const hit = resp?.value?.[0]?.driveItem;
      if (hit?.id) return { driveId, itemId: hit.id, webUrl: hit.webUrl };
    } catch (e) {
      // fall through to search fallback
    }

    // Fallback A: search the drive and match by SharePoint listItemUniqueId
    try {
      const search = await client
        .api(`/drives/${driveId}/root/search(q='${idOrGuid}')`)
        .select('id,webUrl,name,sharepointIds')
        .get();
      const items: any[] = search?.value ?? [];
      const match = items.find(i => i?.sharepointIds?.listItemUniqueId?.toLowerCase() === idOrGuid.toLowerCase());
      if (match?.id) return { driveId, itemId: match.id, webUrl: match.webUrl };
    } catch (e) {
      // ignore and throw below
    }

    // Fallback B: use Graph search API (broader) to match by listItemUniqueId
    try {
      const body = {
        requests: [
          {
            entityTypes: ['driveItem'],
            query: { queryString: `listItemUniqueId:${idOrGuid}` },
            fields: ['id','name','webUrl','parentReference','sharepointIds']
          }
        ]
      } as any;
      const resp = await client.api('/search/query').post(body);
      const hits: any[] = resp?.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
      const item = hits.map(h => h.resource).find((r: any) => r?.sharepointIds?.listItemUniqueId?.toLowerCase() === idOrGuid.toLowerCase());
      if (item?.id) return { driveId, itemId: item.id, webUrl: item.webUrl };
    } catch (e) {
      // ignore and throw below
    }

    throw new Error(`Could not resolve GUID ${idOrGuid} to a DriveItem in Documents`);
  }

  // Assume already a DriveItem id; verify it exists
  try {
    const di = await client.api(`/drives/${driveId}/items/${idOrGuid}`).get();
    return { driveId, itemId: di.id, webUrl: di.webUrl };
  } catch (e) {
    throw new Error(`Provided id does not exist in Documents drive: ${idOrGuid}`);
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

