// Script to backup the Bloom filter - optimized for large files
const { Storage } = require('@google-cloud/storage');
const Redis = require('ioredis');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');

const BLOOM_BACKUP_FILE_LOCAL = '/app/data/crawl_backups/global_visited_bloom_latest.dump';
const BLOOM_BACKUP_FILE_GCP = 'global_visited_bloom_latest.dump';
const GLOBAL_VISITED_KEY = 'global:visited_bloom';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';

// Create Redis connection
const redisConnection = new Redis({
  host: 'firecrawl-redis-1',
  port: 6379,
  maxRetriesPerRequest: null,
});

async function backupBloomFilter() {
  console.log('Starting manual backup of Bloom filter...');
  
  try {
    // Check if the Bloom filter exists
    const exists = await redisConnection.exists(GLOBAL_VISITED_KEY);
    console.log(`Bloom filter exists in Redis: ${exists === 1}`);
    
    if (!exists) {
      console.error('Bloom filter does not exist in Redis. Cannot backup.');
      return;
    }
    
    // Get filter info for logging
    try {
      const infoResult = await redisConnection.call('BF.INFO', GLOBAL_VISITED_KEY);
      console.log('Bloom filter info:');
      for (let i = 0; i < infoResult.length; i += 2) {
        console.log(`  ${infoResult[i]}: ${infoResult[i+1]}`);
      }
    } catch (infoError) {
      console.error('Error getting Bloom filter info:', infoError.message);
    }
    
    // Add a test item
    console.log('Adding test URL to Bloom filter...');
    try {
      const addResult = await redisConnection.call('BF.ADD', GLOBAL_VISITED_KEY, 'https://test-backup-url.com');
      console.log('Add result:', addResult);
    } catch (addError) {
      console.error('Error adding test URL to Bloom filter:', addError.message);
    }
    
    // Perform direct backup using Redis commands
    console.log('Starting Bloom filter backup...');
    
    // Ensure directory exists
    await fsPromises.mkdir(path.dirname(BLOOM_BACKUP_FILE_LOCAL), { recursive: true });
    
    // Use streams for better memory efficiency
    const writeStream = fs.createWriteStream(BLOOM_BACKUP_FILE_LOCAL);
    
    console.log('Write stream opened for writing');
    
    let iterator = 0;
    let scanCount = 0;
    let totalBytesWritten = 0;
    
    const writeChunk = (chunk) => {
      return new Promise((resolve, reject) => {
        writeStream.write(chunk, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    };
    
    while (true) {
      // Use Redis BF.SCANDUMP to get chunks of the Bloom filter
      const result = await redisConnection.call('BF.SCANDUMP', GLOBAL_VISITED_KEY, iterator);
      
      // Parse the result
      const currentIterator = Number(result[0]);
      const chunkData = result[1];
      
      const chunkSize = chunkData ? chunkData.length : 0;
      console.log(`Scan iteration ${scanCount++}, iterator: ${currentIterator}, chunk size: ${chunkSize} bytes`);
      
      if (!chunkData || chunkSize === 0) {
        console.log('No more data to dump');
        break;
      }
      
      // Write the chunk to file
      const bufferChunk = Buffer.isBuffer(chunkData) ? chunkData : Buffer.from(chunkData);
      await writeChunk(bufferChunk);
      totalBytesWritten += bufferChunk.length;
      
      // Process exit handlers and give the event loop a chance to run other tasks
      await new Promise(resolve => setTimeout(resolve, 0));
      
      if (currentIterator === 0) {
        console.log('Dump complete (iterator is 0)');
        break;
      }
      
      iterator = currentIterator;
    }
    
    // Close the write stream
    await new Promise((resolve, reject) => {
      writeStream.end((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    console.log(`Bloom filter data saved to local file: ${BLOOM_BACKUP_FILE_LOCAL} (${totalBytesWritten} bytes)`);
    
    // Upload to GCP in smaller chunks
    const storage = new Storage();
    console.log(`Uploading to GCP bucket ${GCP_BUCKET} as ${BLOOM_BACKUP_FILE_GCP}...`);
    
    await storage.bucket(GCP_BUCKET).upload(BLOOM_BACKUP_FILE_LOCAL, {
      destination: BLOOM_BACKUP_FILE_GCP,
      resumable: true,
      metadata: {
        contentType: 'application/octet-stream',
      },
    });
    
    console.log(`Successfully uploaded Bloom filter dump to GCP`);
    
    // Delete local file after successful upload
    await fsPromises.unlink(BLOOM_BACKUP_FILE_LOCAL);
    console.log('Local backup file deleted');
    
  } catch (error) {
    console.error('Error during Bloom filter backup:', error);
  } finally {
    // Close Redis connection
    redisConnection.disconnect();
    console.log('Backup process complete. Redis connection closed.');
  }
}

// Handle process signals
process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down gracefully...');
  redisConnection.disconnect();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down gracefully...');
  redisConnection.disconnect();
  process.exit(0);
});

// Set higher memory limits
process.setMaxListeners(20);  // Increase max listeners to avoid warnings

// Run the backup function
backupBloomFilter(); 