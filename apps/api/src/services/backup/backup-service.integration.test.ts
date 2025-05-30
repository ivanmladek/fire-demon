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
const REDIS_DUMP_GCS_PREFIX = 'redis-dump/'; // Prefix for RDB files in GCS
const LOCAL_RDB_PATH = '/data/redis/dump.rdb'; // Path where BackupService downloads/expects RDB

// Helper function to clean up GCS files
async function cleanupGCS(storage, prefix) {
  const [files] = await storage.bucket(TEST_GCP_BUCKET).getFiles({ prefix });
  for (const file of files) {
    logger.info(`[TEST CLEANUP] Deleting GCS file: ${file.name}`);
    await file.delete().catch(err => logger.warn(`[TEST CLEANUP] Failed to delete ${file.name}: ${err.message}`));
  }
}

// Exported verification function for use after external Redis restart
export async function verifyRestoredData() {
  const TEST_CUCKOO_FILTER_KEY = 'test:integration:cuckoo_filter_backup_restore';
  const entriesToAdd = Array.from({length: 1000}, (_, i) => `item_rdb_${i}`);
  const existsResults = await redisConnection.call('cf.mexists', TEST_CUCKOO_FILTER_KEY, ...entriesToAdd) as number[];
  expect(existsResults.every(x => x === 1)).toBe(true);
  const regularValue = await redisConnection.get('test:regular:key');
  expect(regularValue).toBe('regular_value');
}

describe('BackupService - Redis Snapshot Backup and Restore Integration Test', () => {
  let backupService: BackupService;
  let storage: Storage;

  beforeAll(async () => {
    logger.info('[TEST] beforeAll: starting');
    backupService = new BackupService(); 
    storage = new Storage(); 
    try {
      const pong = await redisConnection.ping();
      logger.info(`[TEST] beforeAll: Redis PING response: ${pong}`);
      // Clean up any old RDB files from previous test runs
      await cleanupGCS(storage, REDIS_DUMP_GCS_PREFIX);
      // Clean up local RDB file if it exists
      try {
        const fs = require('fs/promises');
        await fs.unlink(LOCAL_RDB_PATH);
        logger.info(`[TEST] beforeAll: Deleted local RDB file: ${LOCAL_RDB_PATH}`);
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          logger.warn(`[TEST] beforeAll: Could not delete local RDB file ${LOCAL_RDB_PATH}`, err);
        }
      }
    } catch (err: any) {
      logger.error('[TEST] beforeAll: Redis PING or cleanup failed', err);
      throw err; // Fail fast
    }
    logger.info('[TEST] beforeAll: finished');
  }, 120000);

  afterAll(async () => {
    logger.info('[TEST] afterAll: starting');
    try {
      const pong = await redisConnection.ping();
      logger.info(`[TEST] afterAll: Redis PING response: ${pong}`);
      // Clean up RDB files created during the test
      await cleanupGCS(storage, REDIS_DUMP_GCS_PREFIX);
      // Clean up local RDB file if it exists
      try {
        const fs = require('fs/promises');
        await fs.unlink(LOCAL_RDB_PATH);
        logger.info(`[TEST] afterAll: Deleted local RDB file: ${LOCAL_RDB_PATH}`);
      } catch (err: any) {
        if (err.code !== 'ENOENT') {
          logger.warn(`[TEST] afterAll: Could not delete local RDB file ${LOCAL_RDB_PATH}`, err);
        }
      }
    } catch (err: any) {
      logger.error('[TEST] afterAll: Redis PING or cleanup failed', err);
    }
    // await redisConnection.quit(); // Ensure this is handled if connections are not auto-closed by Jest
    logger.info('[TEST] afterAll: finished');
  }, 120000);

  it('should backup Redis RDB to GCS and then restore it locally', async () => {
    // 1. Add some data to Redis to ensure dump.rdb is not empty
    const testKey = 'rdb-backup-test-key';
    const testValue = `test-value-${Date.now()}`;
    await redisConnection.set(testKey, testValue);
    const retrievedValue = await redisConnection.get(testKey);
    expect(retrievedValue).toBe(testValue);
    logger.info(`[TEST] Set initial Redis key '${testKey}' to '${testValue}'`);

    // 2. Backup Redis snapshot to GCS
    logger.info('[TEST] Calling backupRedisSnapshotToGCS...');
    await backupService.backupRedisSnapshotToGCS();
    logger.info('[TEST] backupRedisSnapshotToGCS completed.');

    // 3. Verify backup in GCS
    const [gcsFilesBackup] = await storage.bucket(TEST_GCP_BUCKET).getFiles({ prefix: REDIS_DUMP_GCS_PREFIX });
    expect(gcsFilesBackup.length).toBeGreaterThan(0);
    logger.info(`[TEST] Found ${gcsFilesBackup.length} RDB file(s) in GCS after backup.`);
    // Sort to get the latest one if multiple exist (though after cleanup, should be 1)
    gcsFilesBackup.sort((a, b) => b.name.localeCompare(a.name));
    const latestGcsDump = gcsFilesBackup[0];
    logger.info(`[TEST] Latest GCS dump is: ${latestGcsDump.name}`);

    // 4. Simulate losing local RDB (delete it)
    try {
      const fs = require('fs/promises');
      await fs.unlink(LOCAL_RDB_PATH);
      logger.info(`[TEST] Deleted local RDB file ${LOCAL_RDB_PATH} to simulate loss.`);
    } catch (err: any) {
      if (err.code !== 'ENOENT') { // If it already didn't exist, that's fine for this step
        logger.warn(`[TEST] Could not delete local RDB file ${LOCAL_RDB_PATH} before restore: `, err);
        throw err; // If it's another error, it's problematic
      }
      logger.info(`[TEST] Local RDB file ${LOCAL_RDB_PATH} did not exist before restore, which is fine.`);
    }

    // 5. Restore Redis snapshot from GCS
    logger.info('[TEST] Calling restoreRedisSnapshotFromGCS...');
    await backupService.restoreRedisSnapshotFromGCS();
    logger.info('[TEST] restoreRedisSnapshotFromGCS completed.');

    // 6. Verify local RDB file exists after restore
    const fs = require('fs'); // Using fs sync for a simple check
    const localRdbExists = fs.existsSync(LOCAL_RDB_PATH);
    expect(localRdbExists).toBe(true);
    logger.info(`[TEST] Local RDB file ${LOCAL_RDB_PATH} exists after restore.`);

    // Note: We cannot easily verify the *contents* of the restored RDB here 
    // without restarting Redis, which is out of scope for this standalone test.
    // The presence of the file is the primary check for the restore function.

  }, 180000); // Increased timeout for GCS operations and BGSAVE
}); 