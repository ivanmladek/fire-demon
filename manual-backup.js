// Manual backup script to forcefully trigger a backup for a crawl ID
const { Storage } = require('@google-cloud/storage');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Configuration
const CRAWL_ID = 'ed7c7e88-8f5e-4ce1-bc05-80661b8a1fd2';
const DOMAIN = 'contactout.com';
const BATCH_SIZE = 2000;
const BACKUP_DIR = '/tmp/crawl_backups';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';

// Create ScrapedData interface
class ScrapedData {
  constructor(url, content, links) {
    this.url = url;
    this.scrape_timestamp = new Date().toISOString();
    this.content = content || {};
    this.links_found = links || [];
  }
}

// Create BackupMetadata interface
class BackupMetadata {
  constructor(crawlId, totalJobs, batchNumber, domain) {
    this.crawl_id = crawlId;
    this.timestamp = new Date().toISOString();
    this.total_jobs = totalJobs;
    this.batch_number = batchNumber;
    this.domain = domain;
  }
}

class BackupFile {
  constructor(metadata, scraped_data) {
    this.metadata = metadata;
    this.scraped_data = scraped_data;
  }
}

// Helper function to execute Redis commands via Docker
async function redisCommand(command) {
  const { stdout } = await execPromise(`docker exec firecrawl-redis-1 redis-cli ${command}`);
  return stdout.trim();
}

// Helper function to get Redis values that might be JSON
async function getRedisJson(key) {
  const result = await redisCommand(`get ${key}`);
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch (e) {
    return result;
  }
}

// Helper function to get Redis set members
async function getRedisSetMembers(key) {
  const result = await redisCommand(`smembers ${key}`);
  return result ? result.split('\n').filter(Boolean) : [];
}

async function createManualBackup() {
  console.log('Starting manual backup process...');
  
  try {
    console.log('Connecting to Redis via Docker...');
    
    // Initialize Google Cloud Storage
    console.log('Initializing Storage client...');
    const storage = new Storage();
    
    // Create backup directory if it doesn't exist
    await fs.mkdir(path.join(BACKUP_DIR, DOMAIN), { recursive: true });
    console.log(`Created backup directory: ${path.join(BACKUP_DIR, DOMAIN)}`);
    
    // Check the total completed jobs
    const completedJobCount = parseInt(await redisCommand(`llen crawl:${CRAWL_ID}:jobs_done_ordered`), 10);
    console.log(`Total completed jobs: ${completedJobCount}`);
    
    // Calculate total batches (we'll start with just one batch for simplicity)
    const batchNumber = 1;
    const batchStartIndex = 0;
    const batchEndIndex = BATCH_SIZE - 1;
    
    // Get job IDs for this batch from the ordered list
    const jobIdsResult = await redisCommand(`lrange crawl:${CRAWL_ID}:jobs_done_ordered ${batchStartIndex} ${batchEndIndex}`);
    const jobIds = jobIdsResult ? jobIdsResult.split('\n').filter(Boolean) : [];
    
    if (!jobIds || jobIds.length === 0) {
      console.error('No job IDs found for the batch. Exiting.');
      process.exit(1);
    }
    
    console.log(`Found ${jobIds.length} job IDs for batch ${batchNumber}`);
    
    // Get URLs associated with these jobs
    const scrapedData = [];
    
    // For each job ID, fetch the URL and content (only process first 10 for testing)
    for (const jobId of jobIds.slice(0, 10)) {
      console.log(`Processing job ${jobId}...`);
      
      try {
        // Need to get URL for each job
        const jobData = await getRedisJson(`crawl:${CRAWL_ID}:job:${jobId}`);
        
        if (!jobData) {
          console.warn(`No data found for job ${jobId} - this is normal during active crawls`);
          continue;
        }
        
        const url = jobData.url;
        
        if (!url) {
          console.warn(`No URL found in job data for job ${jobId}`);
          continue;
        }
        
        // Get content for this URL
        const content = await getRedisJson(`crawl:${CRAWL_ID}:content:${url}`);
        const links = await getRedisSetMembers(`crawl:${CRAWL_ID}:links:${url}`);
        
        if (content) {
          scrapedData.push(new ScrapedData(
            url,
            content,
            links || []
          ));
          console.log(`Added data for URL: ${url}`);
        } else {
          console.warn(`No content found for URL ${url} from job ${jobId}`);
        }
      } catch (parseError) {
        console.error(`Error processing job data for job ${jobId}`, parseError);
        continue;
      }
    }
    
    if (scrapedData.length === 0) {
      console.error('No valid data found. Exiting.');
      process.exit(1);
    }
    
    console.log(`Processed ${scrapedData.length} URLs with content`);
    
    // Create backup metadata
    const backupFile = new BackupFile(
      new BackupMetadata(CRAWL_ID, completedJobCount, batchNumber, DOMAIN),
      scrapedData
    );
    
    // Save to local file
    const timestamp = Date.now();
    const filename = `backup-test-${CRAWL_ID}-${timestamp}.json`;
    const filepath = path.join(BACKUP_DIR, DOMAIN, filename);
    
    await fs.writeFile(filepath, JSON.stringify(backupFile, null, 2));
    console.log(`Saved backup to local file: ${filepath}`);
    
    // Upload to GCP
    await storage.bucket(GCP_BUCKET).upload(filepath, {
      destination: filename,
      metadata: {
        contentType: 'application/json'
      }
    });
    console.log(`Successfully uploaded to GCP bucket: ${GCP_BUCKET}/${filename}`);
    
    console.log('✅ Manual backup completed successfully!');
    
  } catch (error) {
    console.error('❌ Error during manual backup:', error);
  }
}

// Run the manual backup
createManualBackup(); 