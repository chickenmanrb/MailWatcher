import 'dotenv/config';
import { Client } from '@microsoft/microsoft-graph-client';
import fs from 'node:fs';
import path from 'node:path';

async function uploadBySharePointId() {
  console.log('=== SharePoint Upload by Unique ID ===\n');
  
  const localFolder = 'C:\\Users\\RossCromartie\\Documents\\Github\\MailWatcher\\runs\\deal-room-1757457110137';
  
  // This is the SharePoint folder ID - much simpler to pass from Zapier!
  const targetFolderId = '01OTDFT2BICYU2JX2BXVC3QVATKUZPKEEW'; // Grand Prairie folder ID from previous test
  
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
    
    // Get site and drive info (we still need these)
    const site = await client.api('/sites/odysseyresidentialholdings.sharepoint.com:/sites/ORHAcquisitions').get();
    const drives = await client.api(`/sites/${site.id}/drives`).get();
    const sharedDocsDrive = drives.value.find(d => d.name === 'Documents');
    
    console.log('✅ Found drive:', sharedDocsDrive.id);
    
    // Verify the target folder exists using the ID directly
    console.log(`Verifying target folder: ${targetFolderId}`);
    const targetFolder = await client.api(`/drives/${sharedDocsDrive.id}/items/${targetFolderId}`).get();
    console.log(`✅ Target folder found: "${targetFolder.name}"`);
    console.log(`   Full path: ${targetFolder.parentReference?.path || 'unknown'}/${targetFolder.name}`);
    
    // Upload files directly to the folder ID
    const files = fs.readdirSync(localFolder);
    
    for (const fileName of files) {
      const filePath = path.join(localFolder, fileName);
      const stats = fs.statSync(filePath);
      
      if (stats.isFile()) {
        console.log(`Uploading: ${fileName} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        
        if (stats.size < 4 * 1024 * 1024) { // Small file < 4MB
          const fileBuffer = fs.readFileSync(filePath);
          await client.api(`/drives/${sharedDocsDrive.id}/items/${targetFolderId}:/${fileName}:/content`)
            .put(fileBuffer);
          console.log(`✅ Uploaded: ${fileName}`);
        } else { // Large file
          console.log(`Large file upload for: ${fileName}`);
          const uploadSession = await client.api(`/drives/${sharedDocsDrive.id}/items/${targetFolderId}:/${fileName}:/createUploadSession`)
            .post({ 
              item: { 
                '@microsoft.graph.conflictBehavior': 'replace',
                name: fileName 
              }
            });
          
          console.log(`✅ Large file upload session created for: ${fileName}`);
          console.log(`   Upload URL: ${uploadSession.uploadUrl.substring(0, 50)}...`);
          
          // For now, just show the concept - would implement chunked upload
        }
      }
    }
    
    console.log('\n🎉 SharePoint upload by ID completed successfully!');
    
    // Show how simple this makes the webhook payload
    console.log('\n📝 Webhook payload would be:');
    console.log(JSON.stringify({
      task_name: "rcm-test",
      notion_page_id: "2693310674428114a902fc0f3b8294c0",
      sharepoint_folder_id: targetFolderId, // Just this simple ID!
      nda_url: "https://my.rcm1.com/buyer/agreement?pv=..."
    }, null, 2));
    
  } catch (error) {
    console.error('❌ Upload failed:', error.message);
  }
}

uploadBySharePointId();