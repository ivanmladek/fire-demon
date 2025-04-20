import "dotenv/config";
import { redisConnection } from './queue-service';
import { logger } from '../lib/logger';

const BLOOM_BACKUP_FILE_LOCAL = '/app/data/crawl_backups/global_visited_bloom_latest.dump';
const BLOOM_BACKUP_FILE_GCP = 'global_visited_bloom_latest.dump';
const GLOBAL_VISITED_KEY = 'global:visited_bloom';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';

async function backupBloomFilter() {
  console.log('Starting manual backup of Bloom filter...');
  
  try {
    // Check if the Bloom filter exists
    const exists = await redisConnection.exists(GLOBAL_VISITED_KEY);
    console.log(`Bloom filter exists in Redis: ${exists === 1}`);
    
    // Add a test item
    console.log('Adding test URL to Bloom filter...');
    try {
      const addResult = await redisConnection.call('BF.ADD', GLOBAL_VISITED_KEY, 'https://test-backup-url.com');
      console.log('Add result:', addResult);
    } catch (addError) {
      console.error('Error adding test URL to Bloom filter:', addError.message);
    }
    
    // Perform direct backup using Redis commands
    console.log('Starting Bloom filter backup using direct Redis commands...');
    
    try {
      const { Storage } = require('@google-cloud/storage');
      const fs = require('fs/promises');
      const path = require('path');
      
      // Ensure directory exists
      await fs.mkdir(path.dirname(BLOOM_BACKUP_FILE_LOCAL), { recursive: true });
      const fileHandle = await fs.open(BLOOM_BACKUP_FILE_LOCAL, 'w');
      
      console.log('File handle opened for writing');
      
      let iterator = 0;
      let scanCount = 0;
      while (true) {
        // Use Buffer for command arguments where appropriate
        const result = await redisConnection.call('BF.SCANDUMP', GLOBAL_VISITED_KEY, iterator);
        // Type assertion for the result to handle the unknown type
        const currentIteratorStr = Array.isArray(result) ? result[0] : '0';
        const chunkData = Array.isArray(result) ? result[1] : null;
        const currentIterator = Number(currentIteratorStr);
        
        console.log(`Scan iteration ${scanCount++}, iterator: ${currentIterator}, chunk size: ${chunkData ? chunkData.length : 0}`);
        
        if (!chunkData) { // No more data
          break;
        }
        
        // Ensure chunkData is a Buffer before writing
        const bufferChunk = Buffer.isBuffer(chunkData) ? chunkData : Buffer.from(chunkData);
        await fileHandle.write(bufferChunk);
        
        if (currentIterator === 0) {
          break; // Scan complete
        }
        iterator = currentIterator;
      }
      
      await fileHandle.close(); // Close the file handle
      console.log(`Bloom filter data saved to local file: ${BLOOM_BACKUP_FILE_LOCAL}`);
      
      // Upload to GCP
      const storage = new Storage();
      await storage.bucket(GCP_BUCKET).upload(BLOOM_BACKUP_FILE_LOCAL, {
        destination: BLOOM_BACKUP_FILE_GCP,
      });
      console.log(`Successfully uploaded Bloom filter dump to GCP: ${BLOOM_BACKUP_FILE_GCP}`);
      
      // Delete local file
      await fs.unlink(BLOOM_BACKUP_FILE_LOCAL);
      console.log('Local backup file deleted');
      
      console.log('Bloom filter backup completed successfully!');
    } catch (error) {
      console.error('Error during Bloom filter backup:', error);
    }
  } catch (error) {
    console.error('Error during process:', error);
  } finally {
    console.log('Backup process complete. Exiting...');
  }
  
  // Give time for logs to flush
  await new Promise(resolve => setTimeout(resolve, 1000));
  process.exit(0);
}

// Run the backup function
backupBloomFilter(); 