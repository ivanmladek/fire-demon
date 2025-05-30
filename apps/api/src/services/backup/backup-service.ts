import { redisConnection, getScrapeQueue } from '../queue-service';
import { logger } from '../../lib/logger';
import { Storage } from '@google-cloud/storage';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDoneJobsOrderedLength, markJobsAsBackedUp } from '../../lib/crawl-redis';
import * as Sentry from "@sentry/node";
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

const BATCH_SIZE = 1000;
const BACKUP_DIR = '/app/data/crawl_backups';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';
const CUCKOO_BACKUP_FILE_LOCAL = '/app/data/crawl_backups/global_visited_cuckoo_latest.dump';
const CUCKOO_BACKUP_FILE_GCP_PREFIX = 'global_visited_cuckoo_';
const GLOBAL_VISITED_KEY = 'global:visited_cuckoo';
const BACKUP_INTERVAL_MS = 15 * 60 * 1000;

// Define Cuckoo filter constants here as well, or import them if they are in a shared location
const DEFAULT_CUCKOO_CAPACITY = 300000000; // Target ~240M, add some buffer
const DEFAULT_CUCKOO_BUCKET_SIZE = 2;
const DEFAULT_CUCKOO_MAX_ITERATIONS = 500;
const DEFAULT_CUCKOO_EXPANSION = 1;

const REDIS_DUMP_PATH = './data/redis/dump.rdb'; // Path inside the container
const REDIS_CONTAINER_NAME = 'redis'; // As per docker-compose.yaml

interface BackupMetadata {
  crawl_id: string;
  timestamp: string;
  batch_number: number;
  domain: string;
  batch_size: number;
}

interface ScrapedData {
  url: string;
  scrape_timestamp: string;
  content: any;
  links_found?: string[];
}

interface BackupFile {
  metadata: BackupMetadata;
  scraped_data: ScrapedData[];
}

interface CuckooFilterChunk {
  iterator: number;
  data: string; // base64 encoded
}

interface CuckooFilterBackupData {
  originalParameters: {
    capacity: number;
    bucketSize: number;
    maxIterations: number;
    expansionRate: number; // Note: cf.info might call it expansionRate or expansion
    numItemsInserted: number; // from cf.info
    // Add other cf.info fields if needed
  };
  chunks: CuckooFilterChunk[];
}

export class BackupService {
  private storage: Storage;
  public currentCrawlId: string | null = null;
  private currentDomain: string | null = null;
  private backupCount: number = 0;
  private lastBackupTime: number = 0;
  private dataBuffer: ScrapedData[] = [];
  private backupInProgress: boolean = false;
  private jobIdBuffer: string[] = []; // Track job IDs for cleanup
  
  // Add tracking for speed estimation
  private batchStartTime: number = 0;
  private totalJobsProcessed: number = 0;
  private lastLogTime: number = 0;
  private lastLogCount: number = 0;
  private LOG_INTERVAL_MS = 10000; // Log every 10 seconds

  constructor() {
    this.storage = new Storage();
  }

  public async initializeBackup(crawlId: string, domain: string) {
    this.currentCrawlId = crawlId;
    this.currentDomain = domain;
    this.backupCount = 0;
    this.lastBackupTime = Date.now();
    this.dataBuffer = [];
    this.backupInProgress = false;
    
    // Reset tracking variables
    this.batchStartTime = Date.now();
    this.totalJobsProcessed = 0;
    this.lastLogTime = Date.now();
    this.lastLogCount = 0;
    
    // Create backup directory if it doesn't exist
    await fs.mkdir(path.join(BACKUP_DIR, domain), { recursive: true }).catch(err => {
      logger.error(`Failed to create backup directory for domain ${domain}`, { error: err });
      Sentry.captureException(err, { extra: { crawlId, domain } });
    });
  }

  public addDataToBuffer(data: ScrapedData & { jobId?: string }) {
    if (!this.currentCrawlId) return;

    if (data && data.url && data.content) {
      this.dataBuffer.push(data);
      if (data.jobId) {
        this.jobIdBuffer.push(data.jobId);
      }
      
      this.totalJobsProcessed++;
      const currentBatchSize = this.dataBuffer.length;
      const now = Date.now();
      
      // Log progress at regular intervals or at specific milestones
      const shouldLogMilestone = currentBatchSize % 100 === 0; // Every 100 items
      const shouldLogInterval = (now - this.lastLogTime) >= this.LOG_INTERVAL_MS;
      
      if (shouldLogMilestone || shouldLogInterval) {
        // Calculate speeds
        const overallDuration = (now - this.batchStartTime) / 1000; // seconds
        const overallSpeed = this.totalJobsProcessed / overallDuration;
        
        const intervalDuration = (now - this.lastLogTime) / 1000; // seconds
        const intervalJobs = currentBatchSize - this.lastLogCount;
        const intervalSpeed = intervalJobs / intervalDuration;
        
        // Estimate time to complete batch
        const remainingInBatch = BATCH_SIZE - currentBatchSize;
        const etaSeconds = remainingInBatch / intervalSpeed;
        const etaMinutes = Math.ceil(etaSeconds / 60);
        
        logger.info(`📊 Batch Progress: ${currentBatchSize}/${BATCH_SIZE} (${(currentBatchSize/BATCH_SIZE*100).toFixed(1)}%)`, {
          crawlId: this.currentCrawlId,
          domain: this.currentDomain,
          batchNumber: this.backupCount + 1,
          currentBatchSize,
          totalJobsProcessed: this.totalJobsProcessed,
          overallSpeed: overallSpeed.toFixed(2) + " jobs/sec",
          intervalSpeed: intervalSpeed.toFixed(2) + " jobs/sec (last " + intervalDuration.toFixed(0) + "s)",
          estimatedTimeToBackup: etaMinutes + " minutes",
          memoryUsage: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)} MB`
        });
        
        this.lastLogTime = now;
        this.lastLogCount = currentBatchSize;
      }
    } else {
      logger.warn("Attempted to add invalid data to backup buffer", { crawlId: this.currentCrawlId, data });
    }
  }

  async checkAndBackup() {
    if (!this.currentCrawlId || this.backupInProgress) return;

    const serviceLogger = logger.child({
      module: 'backup-service',
      method: 'checkAndBackup',
      crawlId: this.currentCrawlId
    });

    const bufferSize = this.dataBuffer.length;
    const timeSinceLastBackup = Date.now() - this.lastBackupTime;

    const shouldBackupBySize = bufferSize >= BATCH_SIZE;
    const shouldBackupByTime = bufferSize > 0 && timeSinceLastBackup >= BACKUP_INTERVAL_MS;

    if (shouldBackupBySize || shouldBackupByTime) {
      if (shouldBackupBySize) {
        serviceLogger.info(`Triggering backup: Buffer size ${bufferSize} reached threshold ${BATCH_SIZE}`);
      } else {
        serviceLogger.info(`Triggering backup: Interval ${Math.round(timeSinceLastBackup / 1000)}s reached threshold ${BACKUP_INTERVAL_MS / 1000}s with ${bufferSize} items in buffer.`);
      }
      
      this.backupInProgress = true;
      try {
        const bufferToBackup = [...this.dataBuffer]; 
        const jobIdsToCleanup = [...this.jobIdBuffer];
        await this.createBackup(bufferToBackup);
        // Clean up individual job results after successful backup
        if (jobIdsToCleanup.length > 0) {
          await this.cleanupIndividualJobResults(jobIdsToCleanup);
        }
        this.dataBuffer = []; 
        this.jobIdBuffer = [];
        this.lastBackupTime = Date.now();
        // Reset batch timing for next batch
        this.batchStartTime = Date.now();
        this.lastLogTime = Date.now();
        this.lastLogCount = 0;
        serviceLogger.info(`Successfully backed up ${bufferToBackup.length} items and cleaned up ${jobIdsToCleanup.length} individual job results. Total backups: ${this.backupCount}`);
        // --- NEW: Backup Redis snapshot to GCS after each batch ---
        await this.backupRedisSnapshotToGCS();
      } catch (error) {
        serviceLogger.error(`Backup attempt failed. Buffer not cleared.`, { error });
      } finally {
        this.backupInProgress = false;
      }
    } else if (bufferSize > 0) {
      // Log info about buffer status when not triggering a backup
      serviceLogger.debug(`Buffer status: ${bufferSize}/${BATCH_SIZE} items, time since last backup: ${Math.round(timeSinceLastBackup / 1000)}s/${BACKUP_INTERVAL_MS / 1000}s`);
    }
  }

  private async createBackup(bufferToBackup: ScrapedData[]) {
    if (!this.currentCrawlId || !this.currentDomain) return;

    const currentBatchNumber = this.backupCount + 1;
    
    // Calculate final batch statistics
    const batchDuration = (Date.now() - this.batchStartTime) / 1000; // seconds
    const avgSpeed = bufferToBackup.length / batchDuration;

    const serviceLogger = logger.child({
      module: 'backup-service',
      method: 'createBackup',
      crawlId: this.currentCrawlId,
      batchNumber: currentBatchNumber,
      batchSize: bufferToBackup.length
    });

    serviceLogger.info(`🎯 Starting backup for batch ${currentBatchNumber}. Total jobs completed: ${bufferToBackup.length}`, {
      batchDuration: batchDuration.toFixed(1) + " seconds",
      averageSpeed: avgSpeed.toFixed(2) + " jobs/sec",
      totalJobsProcessed: this.totalJobsProcessed
    });

    if (bufferToBackup.length === 0) {
      serviceLogger.warn(`Buffer is empty. Skipping backup for batch ${currentBatchNumber}.`);
      return; 
    }

    const backupFile: BackupFile = {
      metadata: {
        crawl_id: this.currentCrawlId,
        timestamp: new Date().toISOString(),
        batch_number: currentBatchNumber,
        domain: this.currentDomain,
        batch_size: bufferToBackup.length
      },
      scraped_data: bufferToBackup
    };

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${this.currentDomain}_${this.currentCrawlId}_batch_${currentBatchNumber}_${timestamp}.json`;
    const filepath = path.join(BACKUP_DIR, this.currentDomain, filename);

    try {
      await fs.writeFile(filepath, JSON.stringify(backupFile, null, 2));
      serviceLogger.info(`Saved batch ${currentBatchNumber} to local file: ${filepath}`);

      const gcpDestination = `${this.currentDomain}/${this.currentCrawlId}/${filename}`;
      await this.uploadToGCP(filepath, gcpDestination);
      serviceLogger.info(`Successfully uploaded batch ${currentBatchNumber} to GCP: ${gcpDestination}`);

      this.backupCount++; 

      try {
        await fs.unlink(filepath);
        serviceLogger.info(`Deleted local backup file: ${filepath}`);
      } catch (unlinkError) {
        serviceLogger.warn(`Failed to delete local backup file: ${filepath}`, { error: unlinkError });
      }

    } catch (error) {
      serviceLogger.error(`Failed to create or upload backup for batch ${currentBatchNumber}`, { error });
      Sentry.captureException(error, { 
         extra: { 
           crawlId: this.currentCrawlId, 
           domain: this.currentDomain, 
           batchNumber: currentBatchNumber,
           filepath: filepath 
         } 
      });
      throw error; 
    }
  }

  private async uploadToGCP(filepath: string, destination: string) {
    const serviceLogger = logger.child({ 
        module: 'backup-service', 
        method: 'uploadToGCP', 
        crawlId: this.currentCrawlId,
        filepath, 
        destination 
    });
    try {
      serviceLogger.info(`Attempting to upload backup to GCP.`);
      await this.storage.bucket(GCP_BUCKET).upload(filepath, {
        destination: destination,
        metadata: {
          contentType: 'application/json'
        }
      });
      serviceLogger.info(`Successfully uploaded backup to GCP.`);
    } catch (error) {
      serviceLogger.error(`Failed to upload backup to GCP`, { error });
      Sentry.captureException(error, {
         extra: { 
           crawlId: this.currentCrawlId, 
           domain: this.currentDomain, 
           filepath, 
           destination,
           bucket: GCP_BUCKET
         } 
      });
      throw error;
    }
  }

  private async cleanupIndividualJobResults(jobIds: string[]) {
    const serviceLogger = logger.child({ 
      module: 'backup-service', 
      method: 'cleanupIndividualJobResults', 
      crawlId: this.currentCrawlId,
      jobCount: jobIds.length
    });

    try {
      serviceLogger.info(`Starting cleanup of ${jobIds.length} individual job results`);
      
      // Clean up from Redis - remove job return values to free memory
      const pipeline = redisConnection.pipeline();
      for (const jobId of jobIds) {
        // Remove the job's return value from BullMQ
        const jobKey = `bull:scrapeQueue:${jobId}`;
        pipeline.hdel(jobKey, 'returnvalue');
      }
      await pipeline.exec();
      serviceLogger.info(`Cleared return values from Redis for ${jobIds.length} jobs`);
      
      // Clean up from GCS - delete individual job JSON files
      if (process.env.GCS_BUCKET_NAME) {
        const deletePromises = jobIds.map(async (jobId) => {
          try {
            await this.storage.bucket(process.env.GCS_BUCKET_NAME!).file(`${jobId}.json`).delete();
          } catch (error) {
            // Log but don't throw - file might not exist
            if (error.code !== 404) {
              serviceLogger.warn(`Failed to delete GCS file ${jobId}.json`, { error: error.message });
            }
          }
        });
        
        // Batch delete operations for efficiency
        const batchSize = 100;
        for (let i = 0; i < deletePromises.length; i += batchSize) {
          await Promise.all(deletePromises.slice(i, i + batchSize));
        }
        
        serviceLogger.info(`Cleaned up individual job files from GCS`);
      }
      
      // Mark jobs as backed up in Redis so crawl status knows to look in batch files
      if (this.currentCrawlId) {
        await markJobsAsBackedUp(this.currentCrawlId, jobIds);
        serviceLogger.info(`Marked ${jobIds.length} jobs as backed up`);
      }
      
    } catch (error) {
      serviceLogger.error(`Failed to clean up individual job results`, { error });
      // Don't throw - we don't want cleanup failures to prevent future backups
    }
  }

  async restoreFromBackups(crawlId: string, domain: string) {
    const serviceLogger = logger.child({
      module: 'backup-service',
      method: 'restoreFromBackups',
      crawlId,
      domain
    });

    try {
      // List all backup files for this domain
      const [files] = await this.storage.bucket(GCP_BUCKET).getFiles({
        prefix: `${domain}/${domain}_${crawlId}_`
      });

      if (!files || files.length === 0) {
        serviceLogger.warn(`No backup files found for crawl ${crawlId} in domain ${domain}`);
        return;
      }

      serviceLogger.info(`Found ${files.length} backup files for crawl ${crawlId}`);

      for (const file of files) {
        const [content] = await file.download();
        let backup: BackupFile;
        
        try {
          backup = JSON.parse(content.toString());
        } catch (parseError) {
          serviceLogger.error(`Failed to parse backup file ${file.name}`, { error: parseError });
          continue;
        }

        // Restore content for each URL
        let restoredCount = 0;
        const pipeline = redisConnection.pipeline();

        for (const data of backup.scraped_data) {
          // Add to visited set
          pipeline.sadd(`crawl:${crawlId}:visited_unique`, data.url);
          
          // Store content
          pipeline.set(
            `crawl:${crawlId}:content:${data.url}`, 
            JSON.stringify(data.content)
          );
          
          // Store links if available
          if (data.links_found && data.links_found.length > 0) {
            pipeline.sadd(`crawl:${crawlId}:links:${data.url}`, ...data.links_found);
          }
          
          restoredCount++;
        }
        
        await pipeline.exec();
        serviceLogger.info(`Restored ${restoredCount} URLs from backup file ${file.name}`);
      }

      serviceLogger.info(`Successfully restored backups for crawl ${crawlId}`);
    } catch (error) {
      serviceLogger.error(`Failed to restore backups for crawl ${crawlId}`, { error });
      Sentry.captureException(error);
    }
  }

  // --- NEW: Full Redis snapshot backup to GCS ---
  async backupRedisSnapshotToGCS(): Promise<void> {
    logger.info('[Redis Snapshot] Triggering BGSAVE...');
    await redisConnection.call('BGSAVE');
    // Wait for dump.rdb to be updated (simple sleep, can be improved)
    await new Promise(res => setTimeout(res, 2000));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const gcsFilename = `redis-dump/dump_${timestamp}.rdb`;
    await this.storage.bucket(GCP_BUCKET).upload(REDIS_DUMP_PATH, { destination: gcsFilename });
    logger.info(`[Redis Snapshot] Uploaded Redis dump to GCS: ${gcsFilename}`);
  }

  // --- NEW: Restore Redis snapshot from GCS ---
  async restoreRedisSnapshotFromGCS(): Promise<void> {
    logger.info('[Redis Restore] Looking for latest Redis dump in GCS...');
    const [files] = await this.storage.bucket(GCP_BUCKET).getFiles({ prefix: 'redis-dump/dump_' });
    if (!files.length) throw new Error('No Redis dump found in GCS');
    files.sort((a, b) => b.name.localeCompare(a.name)); // latest first
    const latest = files[0];
    await latest.download({ destination: REDIS_DUMP_PATH });
    logger.info(`[Redis Restore] Downloaded latest Redis dump from GCS: ${latest.name}`);
    // Restart Redis container to load new dump
    await execAsync(`docker compose restart ${REDIS_CONTAINER_NAME}`);
    logger.info('[Redis Restore] Redis container restarted to load new dump');
  }

  async startBackupRoutine() {
    // ... existing code ...
  }
} 