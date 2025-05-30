import { Storage } from '@google-cloud/storage';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import * as zlib from 'zlib';
import { logger } from '../../lib/logger';
import { redisConnection } from '../queue-service';

const storage = new Storage();
const BUCKET_NAME = process.env.GCP_BUCKET || 'firecrawl-backups';
const ITEMS_PER_FILE = 1_000_000; // 1M items per file to keep files manageable

export class CuckooFilterItemTracker {
  private currentBatch: string[] = [];
  private fileIndex = 0;
  private itemCount = 0;
  
  /**
   * Tracks an item that's being added to the Cuckoo filter
   * Batches items and periodically flushes to GCS
   */
  async trackItem(key: string, item: string): Promise<void> {
    this.currentBatch.push(item);
    this.itemCount++;
    
    // Flush batch when it reaches the limit
    if (this.currentBatch.length >= ITEMS_PER_FILE) {
      await this.flushBatch(key);
    }
  }
  
  /**
   * Flushes current batch to GCS as a compressed JSONL file
   */
  private async flushBatch(key: string): Promise<void> {
    if (this.currentBatch.length === 0) return;
    
    const filename = `cuckoo-items/${key}/batch-${this.fileIndex.toString().padStart(6, '0')}.jsonl.gz`;
    const file = storage.bucket(BUCKET_NAME).file(filename);
    
    const writeStream = file.createWriteStream({
      metadata: {
        contentType: 'application/x-jsonlines',
        contentEncoding: 'gzip',
      },
    });
    
    const gzipStream = zlib.createGzip();
    
    // Write items as JSONL (one item per line)
    const itemsStream = new Transform({
      objectMode: true,
      transform(item, encoding, callback) {
        callback(null, JSON.stringify(item) + '\n');
      }
    });
    
    // Stream items through gzip to GCS
    await pipeline(
      this.currentBatch.map(item => itemsStream.write(item)),
      itemsStream,
      gzipStream,
      writeStream
    );
    
    logger.info(`Flushed ${this.currentBatch.length} items to ${filename}`);
    
    this.currentBatch = [];
    this.fileIndex++;
  }
  
  /**
   * Restores a Cuckoo filter from tracked items
   * Streams items from GCS to avoid loading all into memory
   */
  async restoreFromTrackedItems(
    key: string,
    capacity: number,
    bucketSize: number = 2,
    maxIterations: number = 500,
    expansion: number = 1
  ): Promise<void> {
    // Create new Cuckoo filter
    await redisConnection.call('CF.RESERVE', key, capacity, 'BUCKETSIZE', bucketSize, 'MAXITERATIONS', maxIterations, 'EXPANSION', expansion);
    
    // List all batch files
    const [files] = await storage.bucket(BUCKET_NAME).getFiles({
      prefix: `cuckoo-items/${key}/`,
    });
    
    // Sort files to process in order
    files.sort((a, b) => a.name.localeCompare(b.name));
    
    let totalRestored = 0;
    
    // Process each file
    for (const file of files) {
      const readStream = file.createReadStream();
      const gunzipStream = zlib.createGunzip();
      
      let batch: string[] = [];
      
      await pipeline(
        readStream,
        gunzipStream,
        new Transform({
          transform(chunk, encoding, callback) {
            const lines = chunk.toString().split('\n').filter(Boolean);
            
            for (const line of lines) {
              try {
                const item = JSON.parse(line);
                batch.push(item);
                
                // Add items in batches of 1000 for efficiency
                if (batch.length >= 1000) {
                  redisConnection.call('cf.madd', key, ...batch)
                    .then(() => {
                      totalRestored += batch.length;
                      batch = [];
                    })
                    .catch(err => logger.error('Error adding batch to Cuckoo filter', err));
                }
              } catch (e) {
                logger.error('Error parsing item from backup', e);
              }
            }
            
            callback();
          }
        })
      );
      
      // Add remaining items
      if (batch.length > 0) {
        await redisConnection.call('cf.madd', key, ...batch);
        totalRestored += batch.length;
      }
    }
    
    logger.info(`Restored ${totalRestored} items to Cuckoo filter ${key}`);
  }
}

// Singleton instance
export const cuckooFilterItemTracker = new CuckooFilterItemTracker();