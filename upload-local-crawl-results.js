// Script to test the updated BackupService logic: retrieving data from BullMQ and uploading to GCS
const { Storage } = require('@google-cloud/storage');
const { exec } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');

const execAsync = util.promisify(exec);

// Configuration
const CRAWL_ID = process.argv[2] || 'ed7c7e88-8f5e-4ce1-bc05-80661b8a1fd2'; // Use the specific crawl ID
const DOMAIN = 'contactout.com'; // Domain associated with the crawl
const BATCH_SIZE = 10; // Test with a small batch to verify logic
const LOCAL_BACKUP_DIR = '/tmp/test_backup_service_logic';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';
const GCP_TEST_FOLDER = 'test-backup-service-logic'; // Specific folder for this test
const BULLMQ_QUEUE_NAME = 'scrape'; // Default queue name

// Helper function to execute Redis commands via Docker
async function runRedisCommand(command) {
  try {
    // Basic escaping for keys/values - might need more robust escaping
    const escapedCommand = command.replace(/ ([^ ]*)$/, (match, p1) => ` "${p1.replace(/"/g, '\\"')}"`);
    const { stdout, stderr } = await execAsync(`docker exec firecrawl-redis-1 redis-cli ${escapedCommand}`);
    if (stderr && !stderr.includes("Warning: Using a password with options")) { // Ignore password warning
      console.warn(`Redis command stderr: ${stderr.trim()}`);
    }
    return stdout.trim();
  } catch (error) {
    // Return null on error to indicate failure for this command
    return null;
  }
}

// Helper function to parse Redis HGETALL output
function parseHgetall(output) {
  if (!output) return null;
  const lines = output.split('\n');
  const result = {};
  for (let i = 0; i < lines.length; i += 2) {
    if (i + 1 < lines.length) {
      result[lines[i]] = lines[i + 1];
    }
  }
  return result;
}

// Use the same ScrapedData structure as BackupService expects
class ScrapedData {
  constructor(url, content, timestamp) {
    this.url = url;
    this.scrape_timestamp = timestamp || new Date().toISOString();
    this.content = content || {}; // Ensure content is an object
    this.links_found = []; // Keep structure consistent
  }
}

// Use the same BackupFile structure as BackupService expects
class BackupFile {
  constructor(crawlId, domain, scrapedData, batchNumber, totalJobs) {
    this.metadata = {
      crawl_id: crawlId,
      timestamp: new Date().toISOString(),
      domain: domain,
      test_backup_service_logic: true,
      batch_number: batchNumber,
      total_jobs: totalJobs || 0 // Add total jobs if available
    };
    this.scraped_data = scrapedData;
  }
}

async function testBackupServiceLogic() {
  console.log(`Starting test for updated BackupService logic. Crawl: ${CRAWL_ID}`);
  
  try {
    // Initialize Google Cloud Storage
    console.log('Initializing Storage client...');
    const storage = new Storage();
    
    // Create local backup directory
    const localBackupPath = path.join(LOCAL_BACKUP_DIR, DOMAIN);
    await fs.mkdir(localBackupPath, { recursive: true });
    console.log(`Created local backup directory: ${localBackupPath}`);
    
    // Get job IDs for the test batch from the corrected ordered list
    console.log(`Getting ${BATCH_SIZE} job IDs from crawl:${CRAWL_ID}:jobs_done_ordered...`);
    const jobIdsResult = await runRedisCommand(`lrange crawl:${CRAWL_ID}:jobs_done_ordered 0 ${BATCH_SIZE - 1}`);
    const jobIds = jobIdsResult ? jobIdsResult.split('\n').filter(Boolean) : [];
    
    if (!jobIds || jobIds.length === 0) {
      console.error('No job IDs found in ordered list. Cannot proceed.');
      return;
    }
    console.log(`Found ${jobIds.length} job IDs to test.`);
    
    // Attempt to retrieve data primarily from BullMQ hashes
    const scrapedDataArray = [];
    let jobsWithDataCount = 0;
    
    for (const jobId of jobIds) {
      console.log(`--- Processing job ${jobId} ---`);
      let url = null;
      let content = null;
      let timestamp = null;
      let dataFound = false;

      // Fetch BullMQ job data
      console.log(`  Fetching BullMQ hash: bull:${BULLMQ_QUEUE_NAME}:${jobId}`);
      const bullJobRaw = await runRedisCommand(`hgetall bull:${BULLMQ_QUEUE_NAME}:${jobId}`);
      const bullJob = parseHgetall(bullJobRaw);
      
      if (bullJob && bullJob.returnvalue) {
          console.log(`  Found returnvalue in BullMQ hash.`);
          try {
              // BullMQ returnvalue might be nested (e.g., [ { actual_data } ])
              let potentialContent = JSON.parse(bullJob.returnvalue);
              if (Array.isArray(potentialContent) && potentialContent.length > 0) {
                  potentialContent = potentialContent[0]; // Take the first element if it's an array
              }
              
              // Extract URL and content from BullMQ data
              // Prioritize metadata fields for URL
              url = potentialContent?.metadata?.url 
                 || potentialContent?.metadata?.sourceURL 
                 || potentialContent?.url // Fallback to content.url
                 || (bullJob.data ? JSON.parse(bullJob.data).url : null); // Fallback to job.data.url
                 
              content = potentialContent; // Assume the whole object is the content
              timestamp = bullJob.finishedOn ? new Date(parseInt(bullJob.finishedOn, 10)).toISOString() : null;
              
              if (url && content) {
                  dataFound = true;
                  console.log(`  ✅ Extracted URL (${url}) and content from BullMQ returnvalue.`);
              } else {
                  console.warn(`  Could not extract URL or content from BullMQ returnvalue.`);
                  console.log(`  Raw returnvalue: ${bullJob.returnvalue.substring(0, 200)}...`);
              }
              
          } catch (e) {
              console.warn(`  Could not parse BullMQ returnvalue for job ${jobId}: ${e.message}`);
              console.log(` Raw returnvalue: ${bullJob.returnvalue?.substring(0, 200)}...`) // Log raw value on parse failure
          }
      } else if (bullJob) {
          console.log(`  BullMQ hash found, but no 'returnvalue' field.`);
      } else {
          console.log(`  BullMQ hash bull:${BULLMQ_QUEUE_NAME}:${jobId} not found.`);
      }

      // If data was found, add it
      if (dataFound && url && content) {
        scrapedDataArray.push(new ScrapedData(url, content, timestamp));
        jobsWithDataCount++;
      } else {
        console.warn(`  ❌ No usable data found for job ${jobId} from BullMQ hash.`);
        // Optional: Add fallback logic here to check old keys if needed, but primary test is BullMQ
      }
    }
    
    console.log(`--- Summary ---`);
    console.log(`Successfully retrieved data for ${jobsWithDataCount} out of ${jobIds.length} tested jobs using BullMQ logic.`);
    
    if (scrapedDataArray.length === 0) {
      console.warn('No scraped data retrieved for any tested jobs. Skipping GCS upload.');
      return;
    }
    
    // Create backup file structure
    const backupFile = new BackupFile(CRAWL_ID, DOMAIN, scrapedDataArray, 1, BATCH_SIZE); // Simulate batch 1
    
    // Save locally first
    const currentTimestamp = Date.now();
    const filename = `test-backup-logic-${CRAWL_ID}-${currentTimestamp}.json`;
    const localFilepath = path.join(localBackupPath, filename);
    await fs.writeFile(localFilepath, JSON.stringify(backupFile, null, 2));
    console.log(`Saved test backup data locally: ${localFilepath}`);
    
    // Upload to GCS test folder
    const gcsFilepath = `${GCP_TEST_FOLDER}/${filename}`;
    console.log(`Uploading to GCS: gs://${GCP_BUCKET}/${gcsFilepath}`);
    await storage.bucket(GCP_BUCKET).upload(localFilepath, {
      destination: gcsFilepath,
      metadata: {
        contentType: 'application/json'
      }
    });
    console.log(`✅ Successfully uploaded test data to GCS.`);
    
    // Clean up local file
    try {
      await fs.unlink(localFilepath);
      console.log(`Deleted local test file: ${localFilepath}`);
    } catch (unlinkError) {
      console.warn(`Failed to delete local test file: ${localFilepath}`, unlinkError);
    }
    
  } catch (error) {
    console.error('❌ Error during test upload process:', error);
  }
}

// Run the test script
testBackupServiceLogic(); 