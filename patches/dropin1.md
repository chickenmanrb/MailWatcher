Below are two reliable, open-source-backed approaches, plus minimal, working code you can drop into a Node service.

Option A — Use the path you already have (fastest)

Given your metadata shows the server-relative path:

/sites/ORHAcquisitions/Shared Documents/DOTM/2025/Crowley, TX - 96U - Legacy at Crowley


Get the driveId of the “Documents/Shared Documents” library for the site:

GET https://graph.microsoft.com/v1.0/sites/{hostname}:/sites/ORHAcquisitions:/drive


Create an upload session to a file inside that folder (path is relative to the library root):

POST https://graph.microsoft.com/v1.0/drives/{driveId}/root:/DOTM/2025/Crowley, TX - 96U - Legacy at Crowley/{fileName}:/createUploadSession


PUT the bytes to uploadUrl in chunks until complete. (Graph docs pattern.) 
Microsoft Learn
+2
Microsoft Learn
+2

Minimal Node.js (no SDK) example
import { readFileSync } from "node:fs";
import fetch from "node-fetch"; // or global fetch in Node 18+
const token = process.env.GRAPH_TOKEN; // app-only Sites.ReadWrite.All + Files.ReadWrite.All
const sitePath = "sites/ORHAcquisitions";
const folderPath = "DOTM/2025/Crowley, TX - 96U - Legacy at Crowley";
const fileName = "test.pdf";
const bytes = readFileSync("./test.pdf");

// 1) Get driveId for Documents
const siteDrive = await fetch(
  `https://graph.microsoft.com/v1.0/sites/{hostname}:/${sitePath}:/drive`, 
  { headers: { Authorization: `Bearer ${token}` } }
).then(r => r.json());

const driveId = siteDrive.id;

// 2) Create upload session
const sessionRes = await fetch(
  `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${encodeURI(folderPath)}/${encodeURIComponent(fileName)}:/createUploadSession`,
  {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } })
  }
).then(r => r.json());

// 3) Upload whole file (small) or slice (large); here small < 4–8MB for brevity
const put = await fetch(sessionRes.uploadUrl, {
  method: "PUT",
  headers: { "Content-Length": bytes.length.toString(), "Content-Range": `bytes 0-${bytes.length-1}/${bytes.length}` },
  body: bytes
});
const result = await put.json();
console.log(result.id); // driveItem id


This follows Microsoft’s official driveItem + createUploadSession flow and works identically for larger files if you chunk (see “Large file upload” docs or SDK LargeFileUploadTask). 
Microsoft Learn
+1

Option B — Start from the Unique Id (GUID) you have

Your Unique Id = SharePoint list item GUID. Graph uploads can’t address a folder by that GUID directly; you need to resolve GUID → driveItem first, then upload to that driveItem’s children.

Two-step resolution:

Find the library’s listId and then resolve the list item by GUID (expand its driveItem):

GET https://graph.microsoft.com/v1.0/sites/{siteId}/lists/{listId}/items?$filter=fields/UniqueId eq '{GUID}'&$expand=driveItem


This returns the driveItem.id for that folder. (Note: filtering by non-indexed columns can require special headers; best to ensure UniqueId is indexed or accept occasional slow queries.) 
Microsoft Learn
+1

Upload into that folder by driveItem id:

POST https://graph.microsoft.com/v1.0/drives/{driveId}/items/{folderDriveItemId}:/{fileName}:/createUploadSession


Then stream bytes as in Option A. Do not try to call /drive/items/{item-id} with the listItem GUID—Graph expects a driveItem id there, not a listItemUniqueId. 
Microsoft Learn

Good open-source references

Official Graph docs for files & upload sessions (endpoints used above). 
Microsoft Learn
+2
Microsoft Learn
+2

SharePointIds mapping (shows how listItemUniqueId relates to drive items). 
Microsoft Learn

PnP sample: “Upload large file to SharePoint using Graph” (PowerShell/REST flow mirrors the same createUploadSession + chunk PUTs). 
Power Platform Community

Graph JS SDK (includes LargeFileUploadTask if you prefer SDK over manual fetch). 
GitHub

GitHub issue snippet shows the exact request pattern with site + drive + folder path in Node.js. 
GitHub

Why your Unique Id approach likely “isn’t working”

Wrong resource type: uploads act on driveItems; your GUID is a list item GUID. You must resolve to a driveItem first (Option B), or bypass by using a path (Option A). 
Microsoft Learn

Path base confusion: /root:/... paths are relative to the library root (e.g., Shared Documents). Don’t include /sites/{site} when you are under /drives/{driveId}. Use it only when resolving the site. 
Microsoft Learn

Encoding: commas and spaces in folder names must be URL-encoded in the path segment of the request (Graph is picky). Docs examples assume proper encoding. 
Microsoft Learn

Permissions: for app-only, ensure Sites.ReadWrite.All (+ Files.ReadWrite.All for OneDrive/Drives) are granted and admin-consented. (Graph file upload docs/SDK assume this.) 
Microsoft Learn

Quick Node.js (SDK) variant with LargeFileUploadTask

If you want the SDK to manage chunking/retries:

import { Client } from "@microsoft/microsoft-graph-client";
import { TokenCredentialAuthenticationProvider } from "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials";
import { ClientSecretCredential } from "@azure/identity";
import { LargeFileUploadTask } from "@microsoft/microsoft-graph-client";

const cred = new ClientSecretCredential(tenantId, clientId, clientSecret);
const authProvider = new TokenCredentialAuthenticationProvider(cred, { scopes: ["https://graph.microsoft.com/.default"] });
const graph = Client.initWithMiddleware({ authProvider });

// 1) Resolve driveId once (cache it)
const { id: driveId } = await graph.api(`/sites/{hostname}:/sites/ORHAcquisitions:/drive`).get();

// 2) Create upload session to a path
const fileName = "test.pdf";
const folder = "DOTM/2025/Crowley, TX - 96U - Legacy at Crowley";
const session = await graph.api(`/drives/${driveId}/root:/${encodeURI(folder)}/${encodeURIComponent(fileName)}:/createUploadSession`).post({});

const file = Buffer.from(/* your bytes */);
const task = await LargeFileUploadTask.createTaskWithFileObject(graph, file, session, { rangeSize: 5 * 1024 * 1024 });
const result = await task.upload();
console.log(result.responseBody.id);


References for the SDK & large file helper. 
GitHub
+1

TL;DR

Best hook: Use the path you already have (Option A) → it’s simpler and avoids GUID resolution.

If you must use the Unique Id, first resolve GUID → driveItem via the list endpoint (Option B), then upload.

Use createUploadSession and chunked PUTs (or the SDK’s LargeFileUploadTask) to be robust. 
Microsoft Learn
+1

If you want, tell me which language your RPA worker is written in (Node/Python/PowerShell), and I’ll give you a drop-in function that accepts either a serverRelativePath or a listItem GUID and handles the resolution + upload.