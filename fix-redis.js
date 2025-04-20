// Script to fix Redis jobs ordering for crawl job
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

async function runRedisCommand(command) {
  try {
    const { stdout, stderr } = await execAsync(`docker exec firecrawl-redis-1 redis-cli ${command}`);
    if (stderr) {
      console.error(`Error executing command: ${stderr}`);
    }
    return stdout.trim();
  } catch (error) {
    console.error(`Failed to execute command: ${error.message}`);
    throw error;
  }
}

async function main() {
  console.log('Starting Redis fix...');
  
  // Crawl ID to fix
  const crawlId = '398fa156-f8cb-4f62-afb8-a3100728ab99';
  const batchSize = 100; // Process jobs in batches to avoid overloading Redis
  
  try {
    console.log(`Checking crawl data for ID: ${crawlId}`);
    
    // Verify crawl exists
    let result = await runRedisCommand(`exists crawl:${crawlId}`);
    if (result !== '1') {
      console.log('❌ Crawl not found in Redis');
      return;
    }
    
    // Get all completed jobs
    console.log('Getting all completed jobs...');
    result = await runRedisCommand(`smembers crawl:${crawlId}:jobs_done`);
    const completedJobs = result ? result.split('\n') : [];
    console.log(`Found ${completedJobs.length} completed jobs`);
    
    // Get all ordered jobs
    console.log('Getting all ordered jobs...');
    result = await runRedisCommand(`lrange crawl:${crawlId}:jobs_done_ordered 0 -1`);
    const orderedJobs = result ? result.split('\n') : [];
    console.log(`Found ${orderedJobs.length} ordered jobs`);
    
    // Find missing jobs
    const orderedJobsSet = new Set(orderedJobs);
    const missingJobs = completedJobs.filter(job => !orderedJobsSet.has(job));
    console.log(`Found ${missingJobs.length} jobs missing from ordered list`);
    
    if (missingJobs.length === 0) {
      console.log('✅ No jobs to fix!');
      return;
    }
    
    // Only proceed if --fix flag is provided
    if (!process.argv.includes('--fix')) {
      console.log('Run with --fix to fix the missing jobs');
      return;
    }
    
    // Add missing jobs to ordered list in batches
    console.log('Adding missing jobs to ordered list...');
    for (let i = 0; i < missingJobs.length; i += batchSize) {
      const batch = missingJobs.slice(i, i + batchSize);
      const jobList = batch.join(' ');
      const command = `rpush crawl:${crawlId}:jobs_done_ordered ${jobList}`;
      
      console.log(`Adding batch ${i/batchSize + 1}/${Math.ceil(missingJobs.length/batchSize)}...`);
      await runRedisCommand(command);
    }
    
    // Verify the fix
    console.log('Verifying fix...');
    result = await runRedisCommand(`llen crawl:${crawlId}:jobs_done_ordered`);
    const newOrderedJobsCount = parseInt(result || '0');
    console.log(`New ordered jobs count: ${newOrderedJobsCount}`);
    
    if (newOrderedJobsCount === completedJobs.length) {
      console.log('✅ Fix successful! Jobs counts now match');
    } else {
      console.log(`⚠️ Fix incomplete. New count (${newOrderedJobsCount}) still doesn't match completed jobs (${completedJobs.length})`);
    }
    
    // Set an expiry on the key to match Redis TTL pattern in the app
    await runRedisCommand(`expire crawl:${crawlId}:jobs_done_ordered 86400`); // 24 hour expiry
    
    console.log('Redis fix completed');
    
  } catch (error) {
    console.error('Error during Redis fix:', error);
  }
}

// Run the script
main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
}); 