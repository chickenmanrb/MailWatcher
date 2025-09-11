import { FileSystemMonitor } from '../utils/fileSystemMonitor.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function simulateRCMDownload() {
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const testFileName = `test-${Date.now()}-${Math.random().toString(36).substring(7)}.tmp`;
  const testFilePath = path.join(downloadsDir, testFileName);
  
  console.log('=== Testing FileSystemMonitor with simulated download ===');
  console.log('Downloads directory:', downloadsDir);
  console.log('Test file will be:', testFileName);
  
  // Initialize monitor
  const monitor = new FileSystemMonitor({
    stagingDir: path.join(process.cwd(), '.downloads-test'),
    matchers: [
      /\.tmp$/i,
      () => true  // Accept any file
    ],
    appearTimeoutMs: 30_000,
    stableTimeoutMs: 30_000,
    pollMs: 200,
    stableWindowMs: 1000
  });
  
  console.log('\n1. Capturing baseline...');
  await monitor.initBaseline();
  
  // Simulate download starting after 2 seconds
  setTimeout(async () => {
    console.log('\n2. Creating simulated download file (like RCM would)...');
    
    // Start with a small file that grows (simulating download)
    await fs.writeFile(testFilePath, 'Starting download...\n');
    
    // Simulate file growing
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await fs.appendFile(testFilePath, `Chunk ${i}: ${Buffer.alloc(1024, 'x').toString()}\n`);
      console.log(`   File size growing... (chunk ${i + 1}/5)`);
    }
    
    console.log('   Download simulation complete');
    
    // Optionally simulate rename from .tmp to .zip (like some browsers do)
    // const finalName = testFileName.replace('.tmp', '.zip');
    // await fs.rename(testFilePath, path.join(downloadsDir, finalName));
    // console.log(`   Renamed to: ${finalName}`);
  }, 2000);
  
  try {
    console.log('\n3. Waiting for download to appear and stabilize...');
    const stagedPath = await monitor.captureDownload();
    
    console.log('\n✅ SUCCESS! File captured and moved to:', stagedPath);
    
    // Verify the file
    const stats = await fs.stat(stagedPath);
    console.log('   File size:', stats.size, 'bytes');
    
    // Clean up test file
    await fs.unlink(stagedPath).catch(() => {});
    await fs.unlink(testFilePath).catch(() => {});
    
    return true;
  } catch (error) {
    console.error('\n❌ FAILED:', error);
    
    // Clean up on failure
    await fs.unlink(testFilePath).catch(() => {});
    
    return false;
  }
}

// Run the test
simulateRCMDownload().then(success => {
  process.exit(success ? 0 : 1);
});