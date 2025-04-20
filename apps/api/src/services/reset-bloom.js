// Script to reset the Bloom filter
const Redis = require('ioredis');
const { Storage } = require('@google-cloud/storage');

const GLOBAL_VISITED_KEY = 'global:visited_bloom';
const BLOOM_BACKUP_FILE_GCP = 'global_visited_bloom_latest.dump';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';
const BLOOM_ERROR_RATE = 0.01;
const BLOOM_CAPACITY = 300000000;

// Create Redis connection
const redisConnection = new Redis({
  host: 'firecrawl-redis-1',
  port: 6379,
  maxRetriesPerRequest: null,
});

async function resetBloomFilter() {
  try {
    console.log('Starting Bloom filter reset...');
    
    // 1. Check if the Bloom filter exists
    const exists = await redisConnection.exists(GLOBAL_VISITED_KEY);
    console.log(`Bloom filter exists in Redis: ${exists === 1}`);
    
    if (exists) {
      console.log('Deleting existing Bloom filter from Redis...');
      await redisConnection.del(GLOBAL_VISITED_KEY);
      console.log('Existing Bloom filter deleted from Redis.');
    }
    
    // 2. Create a new empty Bloom filter
    console.log(`Creating new Bloom filter with capacity ${BLOOM_CAPACITY} and error rate ${BLOOM_ERROR_RATE}...`);
    await redisConnection.call('BF.RESERVE', GLOBAL_VISITED_KEY, BLOOM_ERROR_RATE, BLOOM_CAPACITY);
    console.log('New Bloom filter created successfully.');
    
    // 3. Delete backup file from GCP if it exists
    try {
      console.log(`Checking if backup file exists in GCP bucket ${GCP_BUCKET}...`);
      const storage = new Storage();
      const [exists] = await storage.bucket(GCP_BUCKET).file(BLOOM_BACKUP_FILE_GCP).exists();
      
      if (exists) {
        console.log(`Deleting backup file from GCP bucket ${GCP_BUCKET}...`);
        await storage.bucket(GCP_BUCKET).file(BLOOM_BACKUP_FILE_GCP).delete();
        console.log('Backup file deleted from GCP.');
      } else {
        console.log('No backup file found in GCP bucket.');
      }
    } catch (gcsError) {
      console.error('Error deleting backup file from GCP:', gcsError);
    }
    
    // 4. Add a test URL to verify it's working
    console.log('Adding test URL to new Bloom filter...');
    const addResult = await redisConnection.call('BF.ADD', GLOBAL_VISITED_KEY, 'https://test-reset-url.com');
    console.log('Test URL added with result:', addResult);
    
    // 5. Verify Bloom filter info
    const infoResult = await redisConnection.call('BF.INFO', GLOBAL_VISITED_KEY);
    console.log('New Bloom filter info:');
    for (let i = 0; i < infoResult.length; i += 2) {
      console.log(`  ${infoResult[i]}: ${infoResult[i+1]}`);
    }
    
    console.log('Bloom filter reset completed successfully!');
  } catch (error) {
    console.error('Error resetting Bloom filter:', error);
  } finally {
    redisConnection.disconnect();
  }
}

// Run the reset function
resetBloomFilter(); 