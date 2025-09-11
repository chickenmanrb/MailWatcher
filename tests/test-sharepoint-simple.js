import 'dotenv/config';
import { Client } from '@microsoft/microsoft-graph-client';

async function testSimpleSharePoint() {
  console.log('=== Testing SharePoint API Directly ===\n');
  
  try {
    // Get authentication token
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
    
    // Try to access the site directly
    console.log('Testing site access...');
    const site = await client.api('/sites/odysseyresidentialholdings.sharepoint.com:/sites/ORHAcquisitions').get();
    console.log('✅ Site access successful:', site.displayName);
    
    // Get the default drive (Shared Documents)
    console.log('Getting default drive...');
    const drives = await client.api(`/sites/${site.id}/drives`).get();
    console.log('Available drives:', drives.value.map(d => ({ name: d.name, id: d.id })));
    
    const sharedDocumentsDrive = drives.value.find(d => d.name === 'Documents');
    if (!sharedDocumentsDrive) {
      throw new Error('Could not find Shared Documents drive');
    }
    
    console.log('✅ Found Shared Documents drive:', sharedDocumentsDrive.id);
    
    // Try to access the root folder
    console.log('Testing root folder access...');
    const rootItems = await client.api(`/drives/${sharedDocumentsDrive.id}/root/children`).get();
    console.log('Root folder contents:', rootItems.value.map(item => ({ name: item.name, type: item.folder ? 'folder' : 'file' })));
    
    // Try to find the DOTM folder
    const dotmFolder = rootItems.value.find(item => item.name === 'DOTM' && item.folder);
    if (dotmFolder) {
      console.log('✅ Found DOTM folder:', dotmFolder.id);
      
      // Try to access the DOTM folder
      const dotmContents = await client.api(`/drives/${sharedDocumentsDrive.id}/items/${dotmFolder.id}/children`).get();
      console.log('DOTM folder contents:', dotmContents.value.map(item => ({ name: item.name, type: item.folder ? 'folder' : 'file' })));
    } else {
      console.log('❌ DOTM folder not found in root');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

testSimpleSharePoint();