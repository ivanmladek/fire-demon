import { BackupService } from './backup-service';
import { redisConnection } from '../queue-service';
import { Storage } from '@google-cloud/storage';
import { logger } from '../../lib/logger';
import * as path from 'path';

// --- Test Configuration ---
const TEST_CUCKOO_FILTER_KEY = 'test:integration:cuckoo_filter_backup_restore';
const TEST_CUCKOO_CAPACITY = 2000; // Ensure capacity is sufficient for 1000 items + buffer
const TEST_CUCKOO_BUCKET_SIZE = 2; // Example, align with your CF.RESERVE parameters
const TEST_CUCKOO_MAX_ITERATIONS = 500; // Example
const TEST_CUCKOO_EXPANSION = 1; // Example
const TEST_GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups'; // Use the same bucket as the app
const CUCKOO_BACKUP_FILE_GCP_PREFIX = 'global_visited_cuckoo_'; // Must match BackupService

// Helper function to clean up GCS files
async function cleanupGCS(storage, prefix) {
  const [files] = await storage.bucket(TEST_GCP_BUCKET).getFiles({ prefix });
  for (const file of files) {
    logger.info(`[TEST CLEANUP] Deleting GCS file: ${file.name}`);
    await file.delete().catch(err => logger.warn(`[TEST CLEANUP] Failed to delete ${file.name}: ${err.message}`));
  }
}

describe('BackupService - Redis Snapshot Backup and Restore Integration Test', () => {
  let backupService: BackupService;
  let storage: Storage;

  beforeAll(async () => {
    backupService = new BackupService();
    storage = new Storage();
    // No need to clean up old Cuckoo filter backups
    await redisConnection.del(TEST_CUCKOO_FILTER_KEY).catch(() => {});
  }, 30000);

  afterAll(async () => {
    await redisConnection.del(TEST_CUCKOO_FILTER_KEY).catch(() => {});
    await redisConnection.quit();
  }, 30000);

  it('should backup and restore the entire Redis instance (including Cuckoo filter) via RDB snapshot and GCS', async () => {
    // 1. Populate Redis with a Cuckoo filter and some keys
    await redisConnection.del(TEST_CUCKOO_FILTER_KEY).catch(() => {});
    await redisConnection.call(
      'CF.RESERVE',
      TEST_CUCKOO_FILTER_KEY,
      TEST_CUCKOO_CAPACITY.toString(),
      'BUCKETSIZE', TEST_CUCKOO_BUCKET_SIZE.toString(),
      'MAXITERATIONS', TEST_CUCKOO_MAX_ITERATIONS.toString(),
      'EXPANSION', TEST_CUCKOO_EXPANSION.toString()
    );
    const entriesToAdd = Array.from({length: 1000}, (_, i) => `item_rdb_${i}`);
    for (const entry of entriesToAdd) {
      await redisConnection.call('cf.add', TEST_CUCKOO_FILTER_KEY, entry);
    }
    // Add a regular key
    await redisConnection.set('test:regular:key', 'regular_value');

    // 2. Backup Redis snapshot to GCS
    await backupService.backupRedisSnapshotToGCS();

    // 3. Simulate data loss: flushall
    await redisConnection.call('FLUSHALL');
    expect(await redisConnection.exists(TEST_CUCKOO_FILTER_KEY)).toBe(0);

    // 4. Restore Redis from GCS snapshot
    await backupService.restoreRedisSnapshotFromGCS();

    // 5. Wait a bit for Redis to restart and reconnect
    await new Promise(res => setTimeout(res, 3000));

    // 6. Verify Cuckoo filter and regular key are restored
    const existsResults = await redisConnection.call('cf.mexists', TEST_CUCKOO_FILTER_KEY, ...entriesToAdd) as number[];
    expect(existsResults.every(x => x === 1)).toBe(true);
    const regularValue = await redisConnection.get('test:regular:key');
    expect(regularValue).toBe('regular_value');
  }, 90000);
}); 