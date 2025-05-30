import { redisConnection } from '../queue-service';
import { logger } from '../../lib/logger';

const RECENT_ITEMS_KEY = 'cuckoo:recent_items';
const MAX_RECENT_ITEMS = 10_000_000; // Keep last 10M items only

export class HybridCuckooBackup {
  /**
   * Track item in both Cuckoo filter and recent items list
   */
  async addItem(cuckooKey: string, item: string): Promise<void> {
    // Add to Cuckoo filter
    await redisConnection.call('CF.ADD', cuckooKey, item);
    
    // Add to recent items (with timestamp for TTL)
    const timestamp = Date.now();
    await redisConnection.zadd(
      `${RECENT_ITEMS_KEY}:${cuckooKey}`,
      timestamp,
      item
    );
    
    // Trim old items to keep memory usage reasonable
    const cutoffTime = timestamp - (7 * 24 * 60 * 60 * 1000); // 7 days
    await redisConnection.zremrangebyscore(
      `${RECENT_ITEMS_KEY}:${cuckooKey}`,
      '-inf',
      cutoffTime
    );
  }
  
  /**
   * Restore Cuckoo filter with recent items + empty capacity for older items
   */
  async restoreWithRecentItems(
    cuckooKey: string,
    capacity: number,
    bucketSize: number = 2,
    maxIterations: number = 500,
    expansion: number = 1
  ): Promise<void> {
    // Create new Cuckoo filter
    await redisConnection.call('CF.RESERVE', cuckooKey, capacity, 'BUCKETSIZE', bucketSize, 'MAXITERATIONS', maxIterations, 'EXPANSION', expansion);
    
    // Get recent items
    const recentItems = await redisConnection.zrange(
      `${RECENT_ITEMS_KEY}:${cuckooKey}`,
      0,
      -1
    );
    
    if (recentItems.length > 0) {
      // Add recent items back in batches
      const batchSize = 1000;
      for (let i = 0; i < recentItems.length; i += batchSize) {
        const batch = recentItems.slice(i, i + batchSize);
        await redisConnection.call('cf.madd', cuckooKey, ...batch);
      }
      
      logger.info(`Restored ${recentItems.length} recent items to Cuckoo filter ${cuckooKey}`);
    } else {
      logger.warn(`No recent items found for ${cuckooKey}, created empty filter`);
    }
  }
} 