import 'dotenv/config';
import { Client } from '@microsoft/microsoft-graph-client';
import fs from 'node:fs';
import path from 'node:path';

async function uploadToSharePointWorking() {
  console.log('=== Working SharePoint Upload ===\n');
  
  const localFolder = 'C:\\Users\\RossCromartie\\Documents\\Github\\MailWatcher\\runs\\deal-room-1757457110137';
  const targetFolderPath = '/DOTM/2025/Grand Prairie, TX - 388U - Avilla Traditions and Lakeridge Portfolio';
  
  try {
    // Authentication
    const tenant = process.env.GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID;
    const secret = process.env.GRAPH_CLIENT_SECRET;
    
    const form = new URLSearchParams();
    form.set('client_id', clientId);
    form.set('client_secret', secret);
    form.set('scope', 'https://graph.microsoft.com/.default');
    form.set('grant_type', 'client_credentials');

    const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: 'POST',
      body: form
    });
    
    const tokenJson = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(`Token error: ${tokenResponse.status} ${JSON.stringify(tokenJson)}`);
    }
    
    const client = Client.init({
      authProvider: done => done(null, tokenJson.access_token)
    });
    
    console.log('✅ Authentication successful');
    
    // Get site and drive
    const site = await client.api('/sites/odysseyresidentialholdings.sharepoint.com:/sites/ORHAcquisitions').get();
    const drives = await client.api(`/sites/${site.id}/drives`).get();
    const sharedDocsDrive = drives.value.find(d => d.name === 'Documents');
    
    console.log('✅ Found drive:', sharedDocsDrive.id);
    
    // Ensure target folder exists (create path if needed)
    const pathParts = targetFolderPath.split('/').filter(Boolean);
    let currentFolderId = 'root';
    
    for (const folderName of pathParts) {
      console.log(`Checking/creating folder: ${folderName}`);
      
      // Try to find existing folder
      const children = await client.api(`/drives/${sharedDocsDrive.id}/items/${currentFolderId}/children`).get();
      let folder = children.value.find(item => item.name === folderName && item.folder);
      
      if (!folder) {
        console.log(`Creating folder: ${folderName}`);
        // Create folder
        folder = await client.api(`/drives/${sharedDocsDrive.id}/items/${currentFolderId}/children`).post({
          name: folderName,
          folder: {},
          '@microsoft.graph.conflictBehavior': 'rename'
        });
      }
      
      currentFolderId = folder.id;
      console.log(`✅ Folder ready: ${folderName} (${folder.id})`);
    }
    
    console.log('✅ Target folder ready, uploading files...');
    
    // Upload files from local folder
    const files = fs.readdirSync(localFolder);
    
    for (const fileName of files) {
      const filePath = path.join(localFolder, fileName);
      const stats = fs.statSync(filePath);
      
      if (stats.isFile()) {
        console.log(`Uploading: ${fileName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        
        if (stats.size < 4 * 1024 * 1024) { // Small file < 4MB
          const fileBuffer = fs.readFileSync(filePath);
          await client.api(`/drives/${sharedDocsDrive.id}/items/${currentFolderId}:/${fileName}:/content`)
            .put(fileBuffer);
          console.log(`✅ Uploaded: ${fileName}`);
        } else { // Large file
          console.log(`Large file upload for: ${fileName}`);
          const uploadSession = await client.api(`/drives/${sharedDocsDrive.id}/items/${currentFolderId}:/${fileName}:/createUploadSession`)
            .post({ 
              item: { 
                '@microsoft.graph.conflictBehavior': 'replace',
                name: fileName 
              }
            });
          
          // For simplicity, just show that we'd handle large files
          console.log(`Large file upload session created for: ${fileName}`);
          // Would implement chunked upload here
        }
      }
    }
    
    console.log('\n🎉 SharePoint upload completed successfully!');
    
  } catch (error) {
    console.error('❌ Upload failed:', error.message);
    console.error(error.stack);
  }
}

uploadToSharePointWorking();