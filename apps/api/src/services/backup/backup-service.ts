import { redisConnection } from '../queue-service';
import { logger } from '../../lib/logger';
import { Storage } from '@google-cloud/storage';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Redis } from 'ioredis';
import { getDoneJobsOrderedLength } from '../../lib/crawl-redis';
import * as Sentry from "@sentry/node";

const BATCH_SIZE = 10000;
const BACKUP_DIR = '/app/data/crawl_backups';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';

interface BackupMetadata {
  crawl_id: string;
  timestamp: string;
  total_jobs: number;
  batch_number: number;
  domain: string;
}

interface ScrapedData {
  url: string;
  scrape_timestamp: string;
  content: {
    title?: string;
    text?: string;
    metadata?: Record<string, any>;
    raw_html?: string;
    status_code?: number;
    headers?: Record<string, string>;
  };
  links_found: string[];
}

interface BackupFile {
  metadata: BackupMetadata;
  scraped_data: ScrapedData[];
}

export class BackupService {
  private redis: Redis;
  private storage: Storage;
  public currentCrawlId: string | null = null;
  private currentDomain: string | null = null;
  private backupCount: number = 0;
  private lastBackupTime: number = 0;

  constructor() {
    this.storage = new Storage();
  }

  public async initializeBackup(crawlId: string, domain: string) {
    this.currentCrawlId = crawlId;
    this.currentDomain = domain;
    this.backupCount = 0;
    this.lastBackupTime = Date.now();
    
    // Create backup directory if it doesn't exist
    await fs.mkdir(path.join(BACKUP_DIR, domain), { recursive: true }).catch(err => {
      logger.error(`Failed to create backup directory for domain ${domain}`, { error: err });
    });
  }

  async checkAndBackup() {
    if (!this.currentCrawlId) return;

    const serviceLogger = logger.child({ 
      module: 'backup-service', 
      method: 'checkAndBackup', 
      crawlId: this.currentCrawlId 
    });
    
    // MODIFIED: Use job count instead of URL count
    try {
      const completedJobCount = await getDoneJobsOrderedLength(this.currentCrawlId);
    
      if (completedJobCount >= (this.backupCount + 1) * BATCH_SIZE) {
        serviceLogger.info(`Triggering backup: ${completedJobCount} completed jobs reaches threshold of ${(this.backupCount + 1) * BATCH_SIZE}`);
        await this.createBackup(completedJobCount);
      }
    } catch (error) {
      serviceLogger.error(`Failed to check for backups: ${error.message}`, { error });
      Sentry.captureException(error);
    }
  }

  private async createBackup(completedJobCount: number) {
    if (!this.currentCrawlId || !this.currentDomain) return;

    const serviceLogger = logger.child({
      module: 'backup-service', 
      method: 'createBackup', 
      crawlId: this.currentCrawlId,
      batchNumber: this.backupCount + 1
    });

    serviceLogger.info(`Starting backup for batch ${this.backupCount + 1}. Total jobs completed: ${completedJobCount}`);

    const batchStartIndex = this.backupCount * BATCH_SIZE;
    const batchEndIndex = batchStartIndex + BATCH_SIZE - 1;

    try {
      // Get job IDs for this batch from the ordered list
      const jobIds = await redisConnection.lrange(
        `crawl:${this.currentCrawlId}:jobs_done_ordered`,
        batchStartIndex,
        batchEndIndex
      );

      if (!jobIds || jobIds.length === 0) {
        serviceLogger.warn(`No job IDs found for batch ${this.backupCount + 1}. Skipping backup.`);
        this.backupCount++; // Increment to prevent getting stuck
        return;
      }

      serviceLogger.info(`Found ${jobIds.length} job IDs for batch ${this.backupCount + 1}`);

      // Get URLs associated with these jobs
      const scrapedData: ScrapedData[] = [];
      const urlsToCleanup: string[] = [];

      // For each job ID, fetch the URL and content
      for (const jobId of jobIds) {
        // Need to get URL for each job
        const jobData = await redisConnection.get(`crawl:${this.currentCrawlId}:job:${jobId}`);
        
        if (!jobData) {
          serviceLogger.warn(`No data found for job ${jobId}`);
          continue;
        }
        
        try {
          const parsedJobData = JSON.parse(jobData);
          const url = parsedJobData.url;
          
          if (!url) {
            serviceLogger.warn(`No URL found in job data for job ${jobId}`);
            continue;
          }
          
          // Get content for this URL
          const content = await redisConnection.get(`crawl:${this.currentCrawlId}:content:${url}`);
          const links = await redisConnection.smembers(`crawl:${this.currentCrawlId}:links:${url}`);
          
          if (content) {
            scrapedData.push({
              url,
              scrape_timestamp: new Date().toISOString(),
              content: JSON.parse(content),
              links_found: links || []
            });
            
            urlsToCleanup.push(url);
          } else {
            serviceLogger.warn(`No content found for URL ${url} from job ${jobId}`);
          }
        } catch (parseError) {
          serviceLogger.error(`Error parsing job data for job ${jobId}`, { error: parseError });
          continue;
        }
      }

      if (scrapedData.length === 0) {
        serviceLogger.warn(`No valid data found for batch ${this.backupCount + 1}. Skipping file creation.`);
        this.backupCount++;
        return;
      }

      // Create backup metadata
      const backupFile: BackupFile = {
        metadata: {
          crawl_id: this.currentCrawlId,
          timestamp: new Date().toISOString(),
          total_jobs: completedJobCount,
          batch_number: this.backupCount + 1,
          domain: this.currentDomain
        },
        scraped_data: scrapedData
      };

      // Save to local file
      const filename = `${this.currentDomain}_${this.currentCrawlId}_batch_${this.backupCount + 1}.json`;
      const filepath = path.join(BACKUP_DIR, this.currentDomain, filename);
      
      await fs.writeFile(filepath, JSON.stringify(backupFile, null, 2));
      serviceLogger.info(`Saved batch ${this.backupCount + 1} to local file: ${filepath}`);

      // Upload to GCP with domain-specific folder
      await this.uploadToGCP(filepath, `${this.currentDomain}/${filename}`);
      serviceLogger.info(`Successfully uploaded batch ${this.backupCount + 1} to GCP`);

      // AGGRESSIVE CLEANUP: Delete data from Redis after successful GCP upload
      serviceLogger.info(`Cleaning up Redis data for ${urlsToCleanup.length} URLs in batch ${this.backupCount + 1}`);
      
      if (urlsToCleanup.length > 0) {
        const pipeline = redisConnection.pipeline();
        for (const url of urlsToCleanup) {
          pipeline.del(`crawl:${this.currentCrawlId}:content:${url}`);
          pipeline.del(`crawl:${this.currentCrawlId}:links:${url}`);
        }
        await pipeline.exec();
        serviceLogger.info(`Redis cleanup complete for batch ${this.backupCount + 1}`);
      }

      // Delete local file after successful upload and cleanup
      try {
        await fs.unlink(filepath);
        serviceLogger.info(`Deleted local backup file: ${filepath}`);
      } catch (unlinkError) {
        serviceLogger.warn(`Failed to delete local backup file: ${filepath}`, { error: unlinkError });
      }

      // Increment backup count
      this.backupCount++;

    } catch (error) {
      serviceLogger.error(`Failed to create backup for batch ${this.backupCount + 1}`, { error });
      Sentry.captureException(error);
      // Don't increment backup count if backup failed
    }
  }

  private async uploadToGCP(filepath: string, destination: string) {
    try {
      await this.storage.bucket(GCP_BUCKET).upload(filepath, {
        destination: destination,
        metadata: {
          contentType: 'application/json'
        }
      });
      logger.info(`Successfully uploaded ${filepath} to GCP as ${destination}`);
    } catch (error) {
      logger.error(`Failed to upload ${filepath} to GCP`, { error });
      throw error; // Re-throw to allow caller to handle the failure
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
} 