// Script to verify and fix Redis data for crawl job
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
  console.log('Starting Redis verification...');
  
  // Crawl ID to check
  const crawlId = '398fa156-f8cb-4f62-afb8-a3100728ab99';
  
  try {
    console.log(`Checking crawl data for ID: ${crawlId}`);
    
    // Check if crawl exists
    let result = await runRedisCommand(`exists crawl:${crawlId}`);
    const crawlExists = result === '1';
    
    if (!crawlExists) {
      console.log('❌ Crawl data not found in Redis');
      return;
    }
    
    console.log('✅ Crawl data found in Redis');
    
    // Get all jobs for this crawl
    result = await runRedisCommand(`scard crawl:${crawlId}:jobs`);
    const totalJobs = parseInt(result || '0');
    console.log(`Total jobs: ${totalJobs}`);
    
    // Get completed jobs
    result = await runRedisCommand(`scard crawl:${crawlId}:jobs_done`);
    const completedJobs = parseInt(result || '0');
    console.log(`Completed jobs: ${completedJobs}`);
    
    // Get ordered completed jobs
    result = await runRedisCommand(`llen crawl:${crawlId}:jobs_done_ordered`);
    const orderedDoneJobsCount = parseInt(result || '0');
    console.log(`Ordered completed jobs: ${orderedDoneJobsCount}`);
    
    // Check if crawl is finished
    result = await runRedisCommand(`exists crawl:${crawlId}:finish`);
    const isFinished = result === '1';
    console.log(`Crawl is finished: ${isFinished ? 'Yes' : 'No'}`);
    
    // Check if crawl kickoff is finished
    result = await runRedisCommand(`exists crawl:${crawlId}:kickoff:finish`);
    const isKickoffFinished = result === '1';
    console.log(`Crawl kickoff is finished: ${isKickoffFinished ? 'Yes' : 'No'}`);
    
    // Check meta data
    result = await runRedisCommand(`hgetall crawl:${crawlId}:meta`);
    console.log('Meta data:', result || 'None');
    
    // Check if there's a mismatch between jobs_done and jobs_done_ordered
    if (completedJobs !== orderedDoneJobsCount) {
      console.log(`⚠️ Mismatch detected: ${completedJobs} completed jobs but ${orderedDoneJobsCount} ordered jobs`);
      
      if (process.argv.includes('--fix')) {
        console.log('Fix option detected, but fixing requires examination of the specific jobs');
        console.log('Please run a more detailed analysis to identify the missing jobs');
      }
    }
    
    console.log('Redis verification completed');
    
  } catch (error) {
    console.error('Error during Redis verification:', error);
  }
}

// Run the script
main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
}); 