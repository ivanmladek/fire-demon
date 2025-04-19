import { redisConnection } from '../queue-service';
import { logger } from '../../lib/logger';
import { Storage } from '@google-cloud/storage';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Redis } from 'ioredis';

const BATCH_SIZE = 10000;
const BACKUP_DIR = '/app/data/crawl_backups';
const GCP_BUCKET = 'firecrawl-backups';

interface BackupMetadata {
  crawl_id: string;
  timestamp: string;
  total_urls: number;
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
    await fs.mkdir(path.join(BACKUP_DIR, domain), { recursive: true });
  }

  async checkAndBackup() {
    if (!this.currentCrawlId) return;

    const visitedCount = await redisConnection.scard(`crawl:${this.currentCrawlId}:visited_unique`);
    
    if (visitedCount >= (this.backupCount + 1) * BATCH_SIZE) {
      await this.createBackup();
    }
  }

  private async createBackup() {
    if (!this.currentCrawlId) return;

    const crawlData = await redisConnection.get(`crawl:${this.currentCrawlId}`);
    if (!crawlData) return;

    const sc = JSON.parse(crawlData);
    const domain = new URL(sc.originUrl!).hostname;
    
    // Get all visited URLs in this batch
    const visitedUrls = await redisConnection.smembers(`crawl:${this.currentCrawlId}:visited_unique`);
    const batchUrls = visitedUrls.slice(this.backupCount * BATCH_SIZE, (this.backupCount + 1) * BATCH_SIZE);

    // Collect scraped data for each URL
    const scrapedData: ScrapedData[] = [];
    for (const url of batchUrls) {
      const content = await redisConnection.get(`crawl:${this.currentCrawlId}:content:${url}`);
      const links = await redisConnection.smembers(`crawl:${this.currentCrawlId}:links:${url}`);
      
      if (content) {
        scrapedData.push({
          url,
          scrape_timestamp: new Date().toISOString(),
          content: JSON.parse(content),
          links_found: links
        });
      }
    }

    // Create backup file
    const backupFile: BackupFile = {
      metadata: {
        crawl_id: this.currentCrawlId,
        timestamp: new Date().toISOString(),
        total_urls: visitedUrls.length,
        batch_number: this.backupCount + 1,
        domain
      },
      scraped_data: scrapedData
    };

    // Save to local file
    const filename = `${domain}_${this.currentCrawlId}_${this.backupCount + 1}.json`;
    const filepath = path.join(BACKUP_DIR, domain, filename);
    await fs.writeFile(filepath, JSON.stringify(backupFile, null, 2));

    // Upload to GCP
    await this.uploadToGCP(filepath, filename);

    this.backupCount++;
  }

  private async uploadToGCP(filepath: string, filename: string) {
    try {
      await this.storage.bucket(GCP_BUCKET).upload(filepath, {
        destination: filename,
        metadata: {
          contentType: 'application/json'
        }
      });
      logger.info(`Successfully uploaded ${filename} to GCP`);
    } catch (error) {
      logger.error(`Failed to upload ${filename} to GCP`, { error });
    }
  }

  async restoreFromBackups(crawlId: string, domain: string) {
    try {
      // List all backup files for this domain
      const [files] = await this.storage.bucket(GCP_BUCKET).getFiles({
        prefix: `${domain}_${crawlId}_`
      });

      for (const file of files) {
        const [content] = await file.download();
        const backup: BackupFile = JSON.parse(content.toString());

        // Restore visited URLs
        for (const data of backup.scraped_data) {
          await redisConnection.sadd(`crawl:${crawlId}:visited_unique`, data.url);
          await redisConnection.set(`crawl:${crawlId}:content:${data.url}`, JSON.stringify(data.content));
          await redisConnection.sadd(`crawl:${crawlId}:links:${data.url}`, ...data.links_found);
        }
      }

      logger.info(`Successfully restored backup for crawl ${crawlId}`);
    } catch (error) {
      logger.error(`Failed to restore backup for crawl ${crawlId}`, { error });
    }
  }
} 