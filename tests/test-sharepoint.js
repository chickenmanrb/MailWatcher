import 'dotenv/config';
import { uploadFolderToSharePoint } from '../src/upload/sharepoint.ts';
import path from 'node:path';

async function testSharePointUpload() {
  const localFolder = 'C:\\Users\\RossCromartie\\Documents\\Github\\MailWatcher\\runs\\deal-room-1757457110137';
  const sharepointUrl = 'https://odysseyresidentialholdings.sharepoint.com/sites/ORHAcquisitions/Shared%20Documents/DOTM/2025/Grand%20Prairie%2C%20TX%20-%20388U%20-%20Avilla%20Traditions%20and%20Lakeridge%20Portfolio';
  
  console.log('Testing SharePoint upload...');
  console.log('Local folder:', localFolder);
  console.log('SharePoint URL:', sharepointUrl);
  
  try {
    await uploadFolderToSharePoint(localFolder, sharepointUrl);
    console.log('SharePoint upload successful!');
  } catch (error) {
    console.error('SharePoint upload failed:');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    // Check environment variables
    console.log('\nEnvironment variables:');
    console.log('GRAPH_TENANT_ID:', process.env.GRAPH_TENANT_ID ? 'Set' : 'Not set');
    console.log('GRAPH_CLIENT_ID:', process.env.GRAPH_CLIENT_ID ? 'Set' : 'Not set'); 
    console.log('GRAPH_CLIENT_SECRET:', process.env.GRAPH_CLIENT_SECRET ? 'Set' : 'Not set');
  }
}

testSharePointUpload().catch(console.error);