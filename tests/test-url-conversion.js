// Test the URL conversion logic

const inputUrl = "https://odysseyresidentialholdings.sharepoint.com/sites/ORHAcquisitions/_api/Web/GetFolderByServerRelativePath(decodedurl='/sites/ORHAcquisitions/Shared Documents/DOTM/2025/Grand Prairie, TX - 388U - Avilla Traditions and Lakeridge Portfolio')";

console.log('Input URL:', inputUrl);

// Extract the path from decodedurl parameter
const match = inputUrl.match(/decodedurl='([^']+)'/);

if (!match) {
  console.error('❌ Could not extract folder path');
  process.exit(1);
}

const folderPath = match[1];
console.log('Extracted folder path:', folderPath);

// Convert to direct SharePoint URL
const directUrl = `https://odysseyresidentialholdings.sharepoint.com${folderPath}`;

// URL encode spaces and special characters
const encodedUrl = directUrl.replace(/\s/g, '%20').replace(/,/g, '%2C');

console.log('Direct URL:', directUrl);
console.log('Encoded URL:', encodedUrl);

// Test the SharePoint upload with this URL
console.log('\n=== Testing SharePoint Upload ===');

import('../src/upload/sharepoint.ts').then(async (module) => {
  const { uploadFolderToSharePoint } = module;
  const testFolder = 'C:\\Users\\RossCromartie\\Documents\\Github\\MailWatcher\\runs\\deal-room-1757457110137';
  
  try {
    await uploadFolderToSharePoint(testFolder, encodedUrl);
    console.log('✅ SharePoint upload successful!');
  } catch (error) {
    console.log('❌ SharePoint upload failed:', error.message);
  }
}).catch(console.error);