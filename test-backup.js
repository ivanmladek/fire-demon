// Simple test script to simulate backing up a file to GCP
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

// Configuration
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';
const TEST_DATA = {
  crawl_id: 'ed7c7e88-8f5e-4ce1-bc05-80661b8a1fd2',
  timestamp: new Date().toISOString(),
  data: [
    { url: 'https://example.com', title: 'Test Page' },
    { url: 'https://example.org', title: 'Another Test Page' }
  ],
  test: true
};
const LOCAL_FILE_PATH = '/tmp/test-backup.json';
const GCP_FILE_PATH = 'test-backup.json';

async function runBackupTest() {
  console.log('Starting GCP backup test...');
  
  try {
    // Initialize Google Cloud Storage
    console.log('Initializing Storage client...');
    const storage = new Storage();
    
    // Create test file
    console.log('Creating test file:', LOCAL_FILE_PATH);
    fs.writeFileSync(LOCAL_FILE_PATH, JSON.stringify(TEST_DATA, null, 2));
    
    // Upload to GCP
    console.log(`Uploading to GCP bucket: ${GCP_BUCKET}, file: ${GCP_FILE_PATH}`);
    await storage.bucket(GCP_BUCKET).upload(LOCAL_FILE_PATH, {
      destination: GCP_FILE_PATH,
    });
    
    console.log('✅ Backup successful!');
    
    // Clean up local file
    fs.unlinkSync(LOCAL_FILE_PATH);
    console.log('Cleaned up local test file');
    
  } catch (error) {
    console.error('❌ Backup test failed:', error.message);
    console.error(error);
  }
}

// Run the test
runBackupTest(); 