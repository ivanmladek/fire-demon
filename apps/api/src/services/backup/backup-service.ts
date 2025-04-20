import { redisConnection, getScrapeQueue } from '../queue-service';
import { logger } from '../../lib/logger';
import { Storage } from '@google-cloud/storage';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getDoneJobsOrderedLength } from '../../lib/crawl-redis';
import * as Sentry from "@sentry/node";

const BATCH_SIZE = 2000;
const BACKUP_DIR = '/app/data/crawl_backups';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';
const BLOOM_BACKUP_FILE_LOCAL = '/app/data/crawl_backups/global_visited_bloom_latest.dump';
const BLOOM_BACKUP_FILE_GCP_PREFIX = 'global_visited_bloom_';
const GLOBAL_VISITED_KEY = 'global:visited_bloom';
const BACKUP_INTERVAL_MS = 15 * 60 * 1000;

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

export class BackupService {
  private storage: Storage;
  public currentCrawlId: string | null = null;
  private currentDomain: string | null = null;
  private backupCount: number = 0;
  private lastBackupTime: number = 0;
  private dataBuffer: ScrapedData[] = [];
  private backupInProgress: boolean = false;

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
    
    // Create backup directory if it doesn't exist
    await fs.mkdir(path.join(BACKUP_DIR, domain), { recursive: true }).catch(err => {
      logger.error(`Failed to create backup directory for domain ${domain}`, { error: err });
      Sentry.captureException(err, { extra: { crawlId, domain } });
    });
  }

  public addDataToBuffer(data: ScrapedData) {
    if (!this.currentCrawlId) return;

    if (data && data.url && data.content) {
      this.dataBuffer.push(data);
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
        await this.createBackup(bufferToBackup);
        this.dataBuffer = []; 
        this.lastBackupTime = Date.now();
        serviceLogger.info(`Successfully backed up ${bufferToBackup.length} items. Total backups: ${this.backupCount}`);
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

    const serviceLogger = logger.child({
      module: 'backup-service',
      method: 'createBackup',
      crawlId: this.currentCrawlId,
      batchNumber: currentBatchNumber,
      batchSize: bufferToBackup.length
    });

    serviceLogger.info(`Starting backup for batch ${currentBatchNumber}. Total jobs completed: 
${bufferToBackup.length}`);

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

  /**
   * Backs up the global Bloom filter to GCP storage
   * @returns Promise<boolean> true if backup was successful, false otherwise
   */
  async backupBloomFilter(): Promise<boolean> {
    const serviceLogger = logger.child({
      module: 'backup-service',
      method: 'backupBloomFilter'
    });
    
    serviceLogger.info(`Starting Bloom filter backup for ${GLOBAL_VISITED_KEY}...`);
    let fileHandle;
    
    try {
      // Create a timestamped filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const gcpDestination = `${BLOOM_BACKUP_FILE_GCP_PREFIX}${timestamp}.dump`;
      
      // Ensure directory exists
      await fs.mkdir(path.dirname(BLOOM_BACKUP_FILE_LOCAL), { recursive: true });
      fileHandle = await fs.open(BLOOM_BACKUP_FILE_LOCAL, 'w'); // Open file for writing

      let iterator = 0;
      while (true) {
        // Use Buffer for command arguments where appropriate
        const result = await redisConnection.call('BF.SCANDUMP', GLOBAL_VISITED_KEY, iterator);
        // Type assertion for the result to handle the unknown type
        const currentIteratorStr = Array.isArray(result) ? result[0] : '0';
        const chunkData = Array.isArray(result) ? result[1] : null;
        const currentIterator = Number(currentIteratorStr);

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
      serviceLogger.info(`Bloom filter data saved to local file: ${BLOOM_BACKUP_FILE_LOCAL}`);

      // Upload to GCP with timestamped filename
      await this.storage.bucket(GCP_BUCKET).upload(BLOOM_BACKUP_FILE_LOCAL, {
        destination: gcpDestination,
      });
      serviceLogger.info(`Successfully uploaded Bloom filter dump to GCP: ${gcpDestination}`);
      
      return true;
    } catch (error) {
      serviceLogger.error(`Failed to backup Bloom filter ${GLOBAL_VISITED_KEY}:`, { error: error.message });
      Sentry.captureException(error);
      if (fileHandle) {
        await fileHandle.close().catch(closeErr => serviceLogger.warn('Error closing file handle during error handling', { closeErr }));
      }
      return false;
    } finally {
      try {
        // Attempt cleanup even on error, check if file exists first
        if (await fs.stat(BLOOM_BACKUP_FILE_LOCAL).catch(() => false)) {
          await fs.unlink(BLOOM_BACKUP_FILE_LOCAL);
        }
      } catch (unlinkError) {
        if (unlinkError.code !== 'ENOENT') {
          serviceLogger.warn(`Failed to delete local Bloom filter dump file: ${BLOOM_BACKUP_FILE_LOCAL}`, { error: unlinkError.message });
        }
      }
    }
  }

  /**
   * Restores the global Bloom filter from GCP storage
   * @returns Promise<boolean> true if restore was successful, false otherwise
   */
  async restoreBloomFilter(): Promise<boolean> {
    const serviceLogger = logger.child({
      module: 'backup-service',
      method: 'restoreBloomFilter'
    });
    
    try {
      const exists = await redisConnection.exists(GLOBAL_VISITED_KEY);
      if (exists) {
        serviceLogger.info(`Bloom filter ${GLOBAL_VISITED_KEY} already exists in Redis.`);
        return true;
      }

      serviceLogger.info(`Attempting to restore Bloom filter ${GLOBAL_VISITED_KEY} from GCP bucket ${GCP_BUCKET}...`);
      
      // Get the list of all Bloom filter backups in GCP
      const [files] = await this.storage.bucket(GCP_BUCKET).getFiles({
        prefix: BLOOM_BACKUP_FILE_GCP_PREFIX
      });
      
      if (!files || files.length === 0) {
        serviceLogger.warn(`No Bloom filter backups found in GCP bucket ${GCP_BUCKET}`);
        // Continue to create a new filter
      } else {
        // Sort files by name to get the latest (assuming timestamp naming pattern)
        const sortedFiles = files.sort((a, b) => b.name.localeCompare(a.name));
        const latestFile = sortedFiles[0];
        
        serviceLogger.info(`Found latest Bloom filter backup: ${latestFile.name}`);
        
        // Download the latest backup file
        await fs.mkdir(path.dirname(BLOOM_BACKUP_FILE_LOCAL), { recursive: true });
        await this.storage.bucket(GCP_BUCKET).file(latestFile.name).download({
          destination: BLOOM_BACKUP_FILE_LOCAL,
        });
        serviceLogger.info(`Downloaded latest Bloom filter dump from GCP: ${latestFile.name}`);

        // Use fs streams to process the file
        const fileHandle = await fs.open(BLOOM_BACKUP_FILE_LOCAL, 'r');
        const fileStats = await fileHandle.stat();
        const buffer = Buffer.alloc(fileStats.size);
        await fileHandle.read(buffer, 0, buffer.length, 0);
        await fileHandle.close();

        // Load the data into Redis
        let iterator = 0;
        await redisConnection.call('BF.LOADCHUNK', GLOBAL_VISITED_KEY, iterator, buffer);
        
        serviceLogger.info(`Successfully restored Bloom filter ${GLOBAL_VISITED_KEY} from GCP dump file.`);
        
        // Clean up
        await fs.unlink(BLOOM_BACKUP_FILE_LOCAL);
        return true;
      }
      
      // If we get here, we need to create a new filter
      serviceLogger.warn(`No usable Bloom filter found in GCP. Creating a new one.`);
      const BLOOM_ERROR_RATE = 0.01;
      const BLOOM_CAPACITY = 300000000;
      await redisConnection.call('BF.RESERVE', GLOBAL_VISITED_KEY, BLOOM_ERROR_RATE, BLOOM_CAPACITY);
      serviceLogger.info(`Initialized new empty Bloom filter ${GLOBAL_VISITED_KEY}.`);
      return true;
    } catch (error) {
      if (error.code === 404 || (error instanceof Error && error.message.includes('No such object'))) {
        serviceLogger.warn(`Bloom filter dump not found in GCP. Initializing new filter ${GLOBAL_VISITED_KEY}.`);
        // Attempt to create a new filter
        try {
          // Check if the filter exists now (race condition handling)
          const existsAgain = await redisConnection.exists(GLOBAL_VISITED_KEY);
          if (!existsAgain) {
            // Use environment variables or defaults for error rate and capacity
            const BLOOM_ERROR_RATE = 0.01;
            const BLOOM_CAPACITY = 300000000;
            await redisConnection.call('BF.RESERVE', GLOBAL_VISITED_KEY, BLOOM_ERROR_RATE, BLOOM_CAPACITY);
            serviceLogger.info(`Initialized new empty Bloom filter ${GLOBAL_VISITED_KEY}.`);
            return true;
          } else {
            serviceLogger.info(`Bloom filter ${GLOBAL_VISITED_KEY} created concurrently, skipping reserve.`);
            return true;
          }
        } catch (initError) {
          if (!(initError instanceof Error && initError.message.includes('ERR item exists'))) {
            serviceLogger.error('Failed to reserve new Bloom filter after restore failed.', { error: initError });
            return false;
          } else {
            serviceLogger.info(`Bloom filter ${GLOBAL_VISITED_KEY} already exists, likely created concurrently.`);
            return true;
          }
        }
      } else {
        serviceLogger.error(`Error restoring Bloom filter ${GLOBAL_VISITED_KEY} from GCP:`, { error: error.message });
        Sentry.captureException(error);
        return false;
      }
    }
  }
} 