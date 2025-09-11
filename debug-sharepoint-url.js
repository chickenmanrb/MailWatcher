import 'dotenv/config';
import { Client } from '@microsoft/microsoft-graph-client';

async function debugSharePointUrl() {
  console.log('=== SharePoint URL Format Debug ===\n');
  
  // The URL you provided from Zapier
  const zapierUrl = 'https://odysseyresidentialholdings.sharepoint.com/:f:/s/ORHAcquisitions/EiW9r4PDQ-FIlnykUySqtEABBhFj8XKFeoSW8AA4-aqEYg?e=uLnYlY';
  
  console.log('Original Zapier URL:');
  console.log(zapierUrl);
  console.log('');
  
  // Parse the URL
  const url = new URL(zapierUrl);
  console.log('URL components:');
  console.log('- Host:', url.host);
  console.log('- Pathname:', url.pathname);
  console.log('- Search params:', url.search);
  console.log('');
  
  // Different URL formats Graph API might expect:
  console.log('Possible correct formats:');
  
  // Format 1: Direct folder URL
  const directUrl = `https://odysseyresidentialholdings.sharepoint.com/sites/ORHAcquisitions/Shared%20Documents`;
  console.log('1. Direct folder URL:', directUrl);
  
  // Format 2: Site-relative path
  const siteUrl = 'https://odysseyresidentialholdings.sharepoint.com/sites/ORHAcquisitions';
  console.log('2. Site URL:', siteUrl);
  
  // Format 3: Document library URL
  const libraryUrl = 'https://odysseyresidentialholdings.sharepoint.com/sites/ORHAcquisitions/Shared%20Documents/Forms/AllItems.aspx';
  console.log('3. Document library URL:', libraryUrl);
  
  console.log('\nThe issue is likely that Zapier gives sharing URLs (with :f: and encoded tokens)');
  console.log('but Graph API needs direct site/folder URLs.');
  console.log('\nLet me try to get authentication working first...\n');
  
  // Test authentication
  try {
    const tenant = process.env.GRAPH_TENANT_ID;
    const clientId = process.env.GRAPH_CLIENT_ID;
    const secret = process.env.GRAPH_CLIENT_SECRET;
    
    console.log('Testing authentication...');
    console.log('Tenant ID:', tenant ? `${tenant.substring(0, 8)}...` : 'NOT SET');
    console.log('Client ID:', clientId ? `${clientId.substring(0, 8)}...` : 'NOT SET');
    console.log('Client Secret:', secret ? 'SET' : 'NOT SET');
    
    // Get token
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
      console.log('❌ Authentication failed:', tokenJson);
      return;
    }
    
    console.log('✅ Authentication successful!');
    
    // Test Graph client
    const client = Client.init({
      authProvider: done => done(null, tokenJson.access_token)
    });
    
    // Try to resolve the Zapier URL using Graph API shares endpoint
    console.log('\nTesting URL resolution with Graph API...');
    
    try {
      const encoded = Buffer.from(zapierUrl).toString('base64url');
      console.log('Base64url encoded URL:', encoded.substring(0, 50) + '...');
      
      const result = await client.api('/shares').query({ q: encoded }).get();
      console.log('✅ URL resolution successful!');
      console.log('Share result:', JSON.stringify(result, null, 2));
      
      if (result.value && result.value[0]) {
        const shareItem = result.value[0];
        console.log('\nShare ID found:', shareItem.id);
        
        // Get the drive item
        const driveItem = await client.api(`/shares/${shareItem.id}/driveItem`).get();
        console.log('Drive item:', JSON.stringify(driveItem, null, 2));
      }
      
    } catch (error) {
      console.log('❌ URL resolution failed:', error.message);
      console.log('This suggests the Zapier URL format might not work with Graph API');
    }
    
  } catch (error) {
    console.log('❌ Error:', error.message);
  }
}

debugSharePointUrl().catch(console.error);