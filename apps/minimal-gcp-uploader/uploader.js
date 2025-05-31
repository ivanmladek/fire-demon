const { Storage } = require('@google-cloud/storage');
const fs = require('fs').promises;
const path = require('path');

// --- Configuration ---
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups';
const LOCAL_BACKUP_DIR = '/app/data/crawl_backups';
const POLLING_INTERVAL_MS = parseInt(process.env.POLLING_INTERVAL_SECONDS || "60") * 1000;
const MAX_RETRIES = parseInt(process.env.MAX_UPLOAD_RETRIES || "3");
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_SECONDS || "10") * 1000;

const storage = new Storage();
let isProcessing = false; // Simple flag to prevent overlapping processing runs

const logger = {
    info: (msg, ...args) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, ...args),
};

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function uploadFile(filepath, destination) {
    logger.info(`Uploading ${filepath} to gs://${GCP_BUCKET}/${destination}`);
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            await storage.bucket(GCP_BUCKET).upload(filepath, {
                destination: destination,
                metadata: { contentType: 'application/json' },
            });
            logger.info(`Successfully uploaded ${filepath} (attempt ${attempt})`);
            return true;
        } catch (err) {
            logger.warn(`Attempt ${attempt} to upload ${filepath} failed:`, err.message);
            if (attempt < MAX_RETRIES) {
                logger.info(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
                await sleep(RETRY_DELAY_MS);
            } else {
                logger.error(`All ${MAX_RETRIES} attempts to upload ${filepath} failed.`);
                return false; // Indicate failure
            }
        }
    }
    return false; // Should not be reached if MAX_RETRIES > 0
}

async function scanAndUpload() {
    if (isProcessing) {
        logger.info('Scan already in progress, skipping this interval.');
        return;
    }
    isProcessing = true;
    logger.info('Scanning for files to upload...');

    try {
        const domainDirs = await fs.readdir(LOCAL_BACKUP_DIR, { withFileTypes: true });
        for (const domainEntry of domainDirs) {
            if (domainEntry.isDirectory()) {
                const domainPath = path.join(LOCAL_BACKUP_DIR, domainEntry.name);
                try {
                    const files = await fs.readdir(domainPath);
                    for (const file of files) {
                        if (file.endsWith('.json')) {
                            const filepath = path.join(domainPath, file);
                            // Construct destination path for GCP (e.g., domain/filename.json)
                            const gcpDestination = `${domainEntry.name}/${file}`;
                            
                            const success = await uploadFile(filepath, gcpDestination);
                            if (success) {
                                try {
                                    await fs.unlink(filepath);
                                    logger.info(`Deleted local file: ${filepath}`);
                                } catch (unlinkErr) {
                                    logger.error(`Failed to delete local file ${filepath}:`, unlinkErr.message);
                                }
                            } else {
                                logger.warn(`Upload failed for ${filepath}, file will remain locally for next scan.`);
                            }
                        }
                    }
                } catch (readDirErr) {
                    logger.warn(`Error reading domain directory ${domainPath}:`, readDirErr.message);
                }
            }
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            logger.info(`Backup directory ${LOCAL_BACKUP_DIR} not found. Will check again later.`);
        } else {
            logger.error('Error scanning backup directory:', err.message);
        }
    } finally {
        isProcessing = false;
        logger.info('Scan complete.');
    }
}

async function main() {
    logger.info('Minimal GCP Uploader Service Started.');
    logger.info(`GCP Bucket: ${GCP_BUCKET}`);
    logger.info(`Polling Interval: ${POLLING_INTERVAL_MS / 1000}s`);

    // Initial scan on startup
    await scanAndUpload();

    // Start polling
    setInterval(scanAndUpload, POLLING_INTERVAL_MS);

    process.on('SIGINT', () => {
        logger.info("SIGINT received. Exiting...");
        process.exit(0);
    });
    process.on('SIGTERM', () => {
        logger.info("SIGTERM received. Exiting...");
        process.exit(0);
    });
}

main(); 