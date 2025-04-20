import { Storage } from '@google-cloud/storage';

async function testGcpAccess() {
  console.log('Testing GCP access...');
  console.log('GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS);
  
  try {
    const storage = new Storage();
    const bucket = storage.bucket(process.env.GCP_BUCKET || 'firecrawl-backups');
    
    console.log('Listing files in bucket:', bucket.name);
    const [files] = await bucket.getFiles();
    
    console.log('Files in bucket:');
    files.forEach(file => {
      console.log(`- ${file.name} (${file.metadata.size} bytes)`);
    });
    
    console.log('GCP access test successful!');
  } catch (error) {
    console.error('Error accessing GCP:', error);
  }
}

testGcpAccess(); 