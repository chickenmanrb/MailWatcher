import 'dotenv/config';
import { uploadFolderToSharePoint } from '../src/upload/sharepoint.js';
import path from 'node:path';

async function testZipUpload() {
  console.log('=== Testing Zip Upload to SharePoint ===\n');
  
  // The zip file from the completed run
  const zipFilePath = 'C:\\Users\\RossCromartie\\Documents\\Github\\MailWatcher\\runs\\deal-room-1757457110137\\artifacts.zip';
  
  // Same SharePoint folder ID we used before
  const targetFolderId = '01OTDFT2BICYU2JX2BXVC3QVATKUZPKEEW'; // Grand Prairie folder ID
  
  console.log('Zip file:', zipFilePath);
  console.log('Target SharePoint folder ID:', targetFolderId);
  
  try {
    // Create a temporary folder containing just the zip file for upload
    const tempDir = path.dirname(zipFilePath);
    const zipDir = path.join(tempDir, 'zip-only');
    
    // We'll upload the parent directory that contains the zip
    await uploadFolderToSharePoint(tempDir, undefined, targetFolderId);
    
    console.log('🎉 Zip upload to SharePoint completed successfully!');
    
  } catch (error) {
    console.error('❌ Zip upload failed:', error.message);
    console.error(error.stack);
  }
}

testZipUpload();