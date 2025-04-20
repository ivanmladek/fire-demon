// backup.test.ts - Manual test script for GCP backup functionality
import { Storage } from "@google-cloud/storage";
import * as fs from 'fs';
import * as path from 'path';

// Constants
const BATCH_SIZE = 2000; // The batch size threshold that triggers backup
const GCP_BUCKET = process.env.GCP_BUCKET || "firecrawl-backups";
const BACKUP_DIR = '/app/data/crawl_backups';

/**
 * This is a manual test script that can be run to verify backup functionality.
 * Run this from the command line using: 
 * ts-node backup.test.ts
 */
async function verifyBackupFunctionality() {
  console.log("Starting backup verification test");
  
  try {
    // Initialize Google Cloud Storage client
    const storage = new Storage();
    
    // Generate a test ID that would be used as the crawl ID
    const testId = Date.now().toString();
    const domain = "contactout.com";
    
    console.log(`Test ID: ${testId}`);
    console.log(`Domain: ${domain}`);
    
    // 1. Check if the GCP bucket exists
    console.log(`Checking if bucket ${GCP_BUCKET} exists...`);
    try {
      const [exists] = await storage.bucket(GCP_BUCKET).exists();
      console.log(`Bucket exists: ${exists}`);
      
      if (!exists) {
        console.error(`Bucket ${GCP_BUCKET} does not exist. Please create it before running this test.`);
        return;
      }
    } catch (error) {
      console.error("Error checking bucket existence:", error);
      return;
    }
    
    // 2. Check Redis configuration - we want to verify the Redis eviction policy
    console.log("\nChecking Redis configuration...");
    console.log("Warning: This test cannot check Redis configuration directly.");
    console.log("Manual step: Verify that Redis is configured with 'noeviction' policy.");
    console.log("Command: docker exec firecrawl-redis-1 redis-cli config get maxmemory-policy");
    console.log("Logs should NOT contain: 'IMPORTANT! Eviction policy is allkeys-lru. It should be \"noeviction\"'");
    
    // 3. Check recent logs for backup attempts
    console.log("\nChecking recent logs for backup attempts...");
    console.log("Manual step: Check Docker logs using:");
    console.log("docker logs firecrawl-worker-1 | grep -i backup | tail -100");
    
    // 4. Validate the storage of job data in Redis
    console.log("\nValidating how job data is stored in Redis...");
    console.log("Manual step: Examine Redis with:");
    console.log("docker exec firecrawl-redis-1 redis-cli");
    console.log("And check keys: KEYS crawl:<CRAWL_ID>:done_jobs*");
    
    // 5. Check why "No data found for job" errors are occurring
    console.log("\nInvestigating 'No data found for job' errors...");
    console.log("These warnings are expected during active crawls - they occur when trying to fetch job data that's still being processed");
    console.log("The fix is to rely only on the dataBuffer which contains already processed URLs instead of fetching from Redis during an active crawl");
    
    // 6. Simulate creating test backup data
    console.log("\nSimulating backup process for testing...");
    const localBackupDir = path.join(process.cwd(), 'test-backups');
    if (!fs.existsSync(localBackupDir)) {
      fs.mkdirSync(localBackupDir, { recursive: true });
    }
    
    // Create a test backup file
    const testData = {
      metadata: {
        crawl_id: testId,
        timestamp: new Date().toISOString(),
        batch_number: 1,
        domain: domain,
        batch_size: 10
      },
      scraped_data: Array(10).fill(0).map((_, i) => ({
        url: `https://${domain}/test-page-${i}`,
        scrape_timestamp: new Date().toISOString(),
        content: { title: `Test Page ${i}` },
        links_found: [`https://${domain}/link-${i}`]
      }))
    };
    
    const backupFilename = `${domain}_${testId}_batch_1_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const backupPath = path.join(localBackupDir, backupFilename);
    
    fs.writeFileSync(backupPath, JSON.stringify(testData, null, 2));
    console.log(`Created local test backup file: ${backupPath}`);
    
    // 7. Upload test backup to GCP to verify permissions
    console.log("\nAttempting to upload test backup to GCP...");
    try {
      await storage.bucket(GCP_BUCKET).upload(backupPath, {
        destination: `${domain}/${testId}/${backupFilename}`,
        metadata: {
          contentType: 'application/json'
        }
      });
      console.log("Test upload successful! GCP permissions are working.");
      
      // Clean up the test file from GCP
      await storage.bucket(GCP_BUCKET).file(`${domain}/${testId}/${backupFilename}`).delete();
      console.log("Cleaned up test file from GCP.");
    } catch (error) {
      console.error("Error uploading to GCP:", error);
      console.log("GCP upload test failed. Check permissions and configuration.");
    }
    
    // 8. Check for issues with the eviction policy in Redis
    console.log("\nChecking for eviction policy issues in Redis...");
    console.log("The logs show 'IMPORTANT! Eviction policy is allkeys-lru. It should be \"noeviction\"'");
    console.log("This suggests Redis is configured to evict keys when memory is full, which could be causing job data loss.");
    console.log("Manual step: Update Redis configuration in docker-compose.yml to use 'noeviction' policy.");
    
    // 9. Provide recommendations
    console.log("\nRecommendations based on test and logs analysis:");
    console.log("1. Fix Redis eviction policy - change from 'allkeys-lru' to 'noeviction'");
    console.log("   - This is likely causing job data to be deleted before backup can occur");
    console.log("2. Add data validation when retrieving jobs from Redis");
    console.log("   - Add fallback mechanisms when 'No data found for job' errors occur");
    console.log("   - Or simply rely on the buffer data which is already populated during processing");
    console.log("3. Monitor both local and GCP backups to ensure they're being created");
    console.log("4. Add retry mechanisms for backup creation");
    
  } catch (error) {
    console.error("Test failed with error:", error);
  }
}

// Run the test if this file is executed directly
if (require.main === module) {
  verifyBackupFunctionality().catch(console.error);
}

export { verifyBackupFunctionality }; 