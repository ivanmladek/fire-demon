import "dotenv/config";
import "./sentry";
import * as Sentry from "@sentry/node";
import { CustomError } from "../lib/custom-error";
import {
  getScrapeQueue,
  getExtractQueue,
  getDeepResearchQueue,
  redisConnection,
  scrapeQueueName,
  extractQueueName,
  deepResearchQueueName,
  getIndexQueue,
  getGenerateLlmsTxtQueue,
  getBillingQueue,
} from "./queue-service";
import { startWebScraperPipeline } from "../main/runWebScraper";
import { callWebhook } from "./webhook";
import { logJob } from "./logging/log_job";
import { Job, Queue } from "bullmq";
import { logger as _logger } from "../lib/logger";
import { Worker } from "bullmq";
import systemMonitor from "./system-monitor";
import { v4 as uuidv4 } from "uuid";
import {
  addCrawlJob,
  addCrawlJobDone,
  addCrawlJobs,
  crawlToCrawler,
  finishCrawl,
  finishCrawlPre,
  finishCrawlKickoff,
  generateURLPermutations,
  getCrawl,
  getCrawlJobCount,
  getCrawlJobs,
  getDoneJobsOrderedLength,
  lockURL,
  lockURLs,
  lockURLsIndividually,
  normalizeURL,
  saveCrawl,
} from "../lib/crawl-redis";
import { StoredCrawl } from "../lib/crawl-redis";
import { addScrapeJob, addScrapeJobs } from "./queue-jobs";
import {
  addJobPriority,
  deleteJobPriority,
  getJobPriority,
} from "../../src/lib/job-priority";
import { getJobs } from "..//controllers/v1/crawl-status";
import { configDotenv } from "dotenv";
import { scrapeOptions } from "../controllers/v1/types";
import {
  cleanOldConcurrencyLimitEntries,
  pushConcurrencyLimitActiveJob,
  removeConcurrencyLimitActiveJob,
  takeConcurrencyLimitedJob,
} from "../lib/concurrency-limit";
import { isUrlBlocked } from "../scraper/WebScraper/utils/blocklist";
import { BLOCKLISTED_URL_MESSAGE } from "../lib/strings";
import { indexPage } from "../lib/extract/index/pinecone";
import { Document } from "../controllers/v1/types";
import {
  ExtractResult,
  performExtraction,
} from "../lib/extract/extraction-service";
import { supabase_service } from "../services/supabase";
import { normalizeUrl, normalizeUrlOnlyHostname } from "../lib/canonical-url";
import { saveExtract, updateExtract } from "../lib/extract/extract-redis";
import { billTeam } from "./billing/credit_billing";
import { saveCrawlMap } from "./indexing/crawl-maps-index";
import { updateDeepResearch } from "../lib/deep-research/deep-research-redis";
import { performDeepResearch } from "../lib/deep-research/deep-research-service";
import { performGenerateLlmsTxt } from "../lib/generate-llmstxt/generate-llmstxt-service";
import { updateGeneratedLlmsTxt } from "../lib/generate-llmstxt/generate-llmstxt-redis";
import { performExtraction_F0 } from "../lib/extract/fire-0/extraction-service-f0";
import { BackupService } from './backup/backup-service';
import { Storage } from '@google-cloud/storage';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createReadStream, createWriteStream } from 'fs';

configDotenv();

class RacedRedirectError extends Error {
  constructor() {
    super("Raced redirect error");
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const workerLockDuration = Number(process.env.WORKER_LOCK_DURATION) || 60000;
const workerStalledCheckInterval =
  Number(process.env.WORKER_STALLED_CHECK_INTERVAL) || 30000;
const jobLockExtendInterval =
  Number(process.env.JOB_LOCK_EXTEND_INTERVAL) || 15000;
const jobLockExtensionTime =
  Number(process.env.JOB_LOCK_EXTENSION_TIME) || 60000;

const cantAcceptConnectionInterval =
  Number(process.env.CANT_ACCEPT_CONNECTION_INTERVAL) || 2000;
const connectionMonitorInterval =
  Number(process.env.CONNECTION_MONITOR_INTERVAL) || 10;
const gotJobInterval = Number(process.env.CONNECTION_MONITOR_INTERVAL) || 20;

const runningJobs: Set<string> = new Set();

const backupService = new BackupService();
let currentCrawlId: string | null = null;

const GLOBAL_VISITED_KEY = 'global:visited_bloom';
const BLOOM_CAPACITY = 300000000; // Target ~240M, add some buffer
const BLOOM_ERROR_RATE = 0.01;
const BLOOM_BACKUP_FILE_LOCAL = '/app/data/crawl_backups/global_visited_bloom_latest.dump';
const BLOOM_BACKUP_FILE_GCP = 'global_visited_bloom_latest.dump';
const GCP_BUCKET = process.env.GCP_BUCKET || 'firecrawl-backups'; // Ensure this is set
const BLOOM_SAVE_INTERVAL = 60 * 60 * 1000; // 1 hour

const storage = new Storage(); // Reuse or ensure single instance

// +++ Bloom Filter Function Definitions +++
async function initializeBloomFilter() {
    const logger = _logger.child({ module: 'bloom-filter', method: 'initialize' });
    try {
        const exists = await redisConnection.exists(GLOBAL_VISITED_KEY);
        // Try to load even if exists in case of partial load previously? Or assume exists means loaded. Let's assume exists is sufficient.
        if (exists) {
            logger.info(`Bloom filter ${GLOBAL_VISITED_KEY} already exists in Redis. Assuming loaded or will be used as is.`);
            return;
        }

        logger.info(`Attempting to restore Bloom filter ${GLOBAL_VISITED_KEY} from GCP bucket ${GCP_BUCKET}...`);
        await fs.mkdir(path.dirname(BLOOM_BACKUP_FILE_LOCAL), { recursive: true });

        await storage.bucket(GCP_BUCKET).file(BLOOM_BACKUP_FILE_GCP).download({
            destination: BLOOM_BACKUP_FILE_LOCAL,
        });
        logger.info(`Downloaded Bloom filter dump from GCP.`);

        // Use fs.createReadStream with specific options if needed, or handle chunk type
        // Node streams default to Buffer unless encoding is set, so direct iteration should work.
        // Let's ensure error handling is robust around the stream.
        const stream = createReadStream(BLOOM_BACKUP_FILE_LOCAL);
        stream.on('error', (err) => {
            logger.error('Error reading local Bloom filter dump stream', { error: err });
            // Handle stream errors, maybe try to initialize empty filter
        });

        let iterator = 0;
        try {
             for await (const chunk of stream) { // This expects stream to be AsyncIterable<Buffer>
                  const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                  await redisConnection.call('BF.LOADCHUNK', GLOBAL_VISITED_KEY, iterator, bufferChunk);
                  iterator++;
             }
        } catch (streamError) {
             logger.error('Error iterating Bloom filter dump stream', { error: streamError });
             throw streamError; // Rethrow to be caught by the outer catch
        }

        logger.info(`Successfully restored Bloom filter ${GLOBAL_VISITED_KEY} from GCP dump file.`);
        await fs.unlink(BLOOM_BACKUP_FILE_LOCAL);

    } catch (error) {
        if (error.code === 404 || (error instanceof Error && error.message.includes('No such object'))) { // Handle GCP 'Not Found'
             logger.warn(`Bloom filter dump not found in GCP. Initializing new filter ${GLOBAL_VISITED_KEY}.`);
             try {
                // Check existence again before reserving to handle race condition
                const existsAgain = await redisConnection.exists(GLOBAL_VISITED_KEY);
                if (!existsAgain) {
                    await redisConnection.call('BF.RESERVE', GLOBAL_VISITED_KEY, BLOOM_ERROR_RATE, BLOOM_CAPACITY);
                    logger.info(`Initialized new empty Bloom filter ${GLOBAL_VISITED_KEY}.`);
                } else {
                     logger.info(`Bloom filter ${GLOBAL_VISITED_KEY} created concurrently, skipping reserve.`);
                }
             } catch (initError) {
                 if (!(initError instanceof Error && initError.message.includes('ERR item exists'))) {
                    logger.error('Failed to reserve new Bloom filter after restore failed.', { error: initError });
                    throw initError;
                 } else {
                    logger.info(`Bloom filter ${GLOBAL_VISITED_KEY} already exists, likely created concurrently.`);
                 }
             }
        } else {
            logger.error(`Error restoring Bloom filter ${GLOBAL_VISITED_KEY} from GCP:`, { error: error.message });
            Sentry.captureException(error);
            // Decide: Proceed with empty filter or throw? Let's proceed but log error.
            // Ensure filter exists even if load failed
            const existsAfterError = await redisConnection.exists(GLOBAL_VISITED_KEY);
             if (!existsAfterError) {
                 try {
                     await redisConnection.call('BF.RESERVE', GLOBAL_VISITED_KEY, BLOOM_ERROR_RATE, BLOOM_CAPACITY);
                     logger.info(`Initialized new empty Bloom filter ${GLOBAL_VISITED_KEY} after load error.`);
                 } catch (reserveError) {
                     logger.error('Failed to reserve Bloom filter after load error.', { error: reserveError });
                 }
             }
        }
    }
}

async function saveBloomFilter() {
    const logger = _logger.child({ module: 'bloom-filter', method: 'save' });
    logger.info(`Starting Bloom filter backup for ${GLOBAL_VISITED_KEY}...`);
    let fileHandle;
    try {
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
        logger.info(`Bloom filter data saved to local file: ${BLOOM_BACKUP_FILE_LOCAL}`);

        // Upload to GCP
        await storage.bucket(GCP_BUCKET).upload(BLOOM_BACKUP_FILE_LOCAL, {
             destination: BLOOM_BACKUP_FILE_GCP,
        });
        logger.info(`Successfully uploaded Bloom filter dump to GCP: ${BLOOM_BACKUP_FILE_GCP}`);

    } catch (error) {
        logger.error(`Failed to backup Bloom filter ${GLOBAL_VISITED_KEY}:`, { error: error.message });
        Sentry.captureException(error);
        if (fileHandle) {
            await fileHandle.close().catch(closeErr => logger.warn('Error closing file handle during error handling', { closeErr }));
        }
    } finally {
        try {
            // Attempt cleanup even on error, check if file exists first
            if (await fs.stat(BLOOM_BACKUP_FILE_LOCAL).catch(() => false)) {
                 await fs.unlink(BLOOM_BACKUP_FILE_LOCAL);
            }
        } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') {
                logger.warn(`Failed to delete local Bloom filter dump file: ${BLOOM_BACKUP_FILE_LOCAL}`, { error: unlinkError.message });
            }
        }
    }
}
// --- End Bloom Filter Function Definitions ---

async function finishCrawlIfNeeded(job: Job & { id: string }, sc: StoredCrawl) {
  if (await finishCrawlPre(job.data.crawl_id)) {
    if (
      job.data.crawlerOptions &&
      !(await redisConnection.exists(
        "crawl:" + job.data.crawl_id + ":invisible_urls",
      ))
    ) {
      await redisConnection.set(
        "crawl:" + job.data.crawl_id + ":invisible_urls",
        JSON.stringify(job.data.crawlerOptions.invisibleUrls),
        "EX",
        60 * 60 * 24,
      );

      const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;

      // Initialize backup service if this is a new crawl
      if (currentCrawlId !== job.data.crawl_id && sc.originUrl) {
        currentCrawlId = job.data.crawl_id;
        const domain = new URL(sc.originUrl!).hostname;
        await backupService.initializeBackup(job.data.crawl_id, domain);
      }

      const visitedUrls = new Set(
        await redisConnection.smembers(
          "crawl:" + job.data.crawl_id + ":visited_unique",
        ),
      );

      const lastUrls: string[] = (
        (
          await supabase_service.rpc("diff_get_last_crawl_urls", {
            i_team_id: job.data.team_id,
            i_url: sc.originUrl!,
          })
        ).data ?? []
      ).map((x) => x.url);

      const lastUrlsSet = new Set(lastUrls);

      const crawler = crawlToCrawler(
        job.data.crawl_id,
        sc,
        sc.originUrl!,
        job.data.crawlerOptions,
      );

      const univistedUrls = crawler.filterLinks(
        Array.from(lastUrlsSet).filter((x) => !visitedUrls.has(x)),
        Infinity,
        sc.crawlerOptions.maxDepth ?? 10,
      );

      const addableJobCount =
        sc.crawlerOptions.limit === undefined
          ? Infinity
          : sc.crawlerOptions.limit -
            (await getDoneJobsOrderedLength(job.data.crawl_id));

      console.log(
        sc.originUrl!,
        univistedUrls,
        visitedUrls,
        lastUrls,
        addableJobCount,
      );

      if (univistedUrls.length !== 0 && addableJobCount > 0) {
        const jobs = univistedUrls.slice(0, addableJobCount).map((url) => {
          const uuid = uuidv4();
          return {
            name: uuid,
            data: {
              url,
              mode: "single_urls" as const,
              team_id: job.data.team_id,
              crawlerOptions: {
                ...job.data.crawlerOptions,
                urlInvisibleInCurrentCrawl: true,
              },
              scrapeOptions: job.data.scrapeOptions,
              internalOptions: sc.internalOptions,
              origin: job.data.origin,
              crawl_id: job.data.crawl_id,
              sitemapped: true,
              webhook: job.data.webhook,
              v1: job.data.v1,
            },
            opts: {
              jobId: uuid,
              priority: 20,
            },
          };
        });

        const lockedIds = await lockURLsIndividually(
          job.data.crawl_id,
          sc,
          jobs.map((x) => ({ id: x.opts.jobId, url: x.data.url })),
        );
        const lockedJobs = jobs.filter((x) =>
          lockedIds.find((y) => y.id === x.opts.jobId),
        );
        await addCrawlJobs(
          job.data.crawl_id,
          lockedJobs.map((x) => x.opts.jobId),
        );
        await addScrapeJobs(lockedJobs);

        return;
      }
    }

    await finishCrawl(job.data.crawl_id);

    (async () => {
      const originUrl = sc.originUrl
        ? normalizeUrlOnlyHostname(sc.originUrl)
        : undefined;
      // Get all visited unique URLs from Redis
      const visitedUrls = await redisConnection.smembers(
        "crawl:" + job.data.crawl_id + ":visited_unique",
      );
      // Upload to Supabase if we have URLs and this is a crawl (not a batch scrape)
      if (
        visitedUrls.length > 0 &&
        job.data.crawlerOptions !== null &&
        originUrl
      ) {
        // Queue the indexing job instead of doing it directly
        await getIndexQueue().add(
          job.data.crawl_id,
          {
            originUrl,
            visitedUrls,
          },
          {
            priority: 10,
          },
        );
      }
    })();

    if (!job.data.v1) {
      const jobIDs = await getCrawlJobs(job.data.crawl_id);

      const jobs = (await getJobs(jobIDs)).sort(
        (a, b) => a.timestamp - b.timestamp,
      );
      // const jobStatuses = await Promise.all(jobs.map((x) => x.getState()));
      const jobStatus = sc.cancelled // || jobStatuses.some((x) => x === "failed")
        ? "failed"
        : "completed";

      const fullDocs = jobs
        .map((x) =>
          x.returnvalue
            ? Array.isArray(x.returnvalue)
              ? x.returnvalue[0]
              : x.returnvalue
            : null,
        )
        .filter((x) => x !== null);

      await logJob({
        job_id: job.data.crawl_id,
        success: jobStatus === "completed",
        message: sc.cancelled ? "Cancelled" : undefined,
        num_docs: fullDocs.length,
        docs: [],
        time_taken: (Date.now() - sc.createdAt) / 1000,
        team_id: job.data.team_id,
        mode: job.data.crawlerOptions !== null ? "crawl" : "batch_scrape",
        url: sc.originUrl!,
        scrapeOptions: sc.scrapeOptions,
        crawlerOptions: sc.crawlerOptions,
        origin: job.data.origin,
      });

      const data = {
        success: jobStatus !== "failed",
        result: {
          links: fullDocs.map((doc) => {
            return {
              content: doc,
              source: doc?.metadata?.sourceURL ?? doc?.url ?? "",
            };
          }),
        },
        project_id: job.data.project_id,
        docs: fullDocs,
      };

      // v0 web hooks, call when done with all the data
      if (!job.data.v1) {
        callWebhook(
          job.data.team_id,
          job.data.crawl_id,
          data,
          job.data.webhook,
          job.data.v1,
          job.data.crawlerOptions !== null
            ? "crawl.completed"
            : "batch_scrape.completed",
        );
      }
    } else {
      const num_docs = await getDoneJobsOrderedLength(job.data.crawl_id);
      const jobStatus = sc.cancelled ? "failed" : "completed";

      await logJob(
        {
          job_id: job.data.crawl_id,
          success: jobStatus === "completed",
          message: sc.cancelled ? "Cancelled" : undefined,
          num_docs,
          docs: [],
          time_taken: (Date.now() - sc.createdAt) / 1000,
          team_id: job.data.team_id,
          scrapeOptions: sc.scrapeOptions,
          mode: job.data.crawlerOptions !== null ? "crawl" : "batch_scrape",
          url:
            sc?.originUrl ??
            (job.data.crawlerOptions === null ? "Batch Scrape" : "Unknown"),
          crawlerOptions: sc.crawlerOptions,
          origin: job.data.origin,
        },
        true,
      );

      // v1 web hooks, call when done with no data, but with event completed
      if (job.data.v1 && job.data.webhook) {
        callWebhook(
          job.data.team_id,
          job.data.crawl_id,
          [],
          job.data.webhook,
          job.data.v1,
          job.data.crawlerOptions !== null
            ? "crawl.completed"
            : "batch_scrape.completed",
        );
      }
    }

    // Check and create backup after job is processed
    await backupService.checkAndBackup();
  }
}

const processJobInternal = async (token: string, job: Job & { id: string }) => {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processJobInternal",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🐂 Worker extending lock on job ${job.id}`, {
      extendInterval: jobLockExtendInterval,
      extensionTime: jobLockExtensionTime,
    });

    if (job.data?.mode !== "kickoff" && job.data?.team_id) {
      await pushConcurrencyLimitActiveJob(job.data.team_id, job.id, 60 * 1000); // 60s lock renew, just like in the queue
    }

    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  await addJobPriority(job.data.team_id, job.id);
  let err = null;
  try {
    if (job.data?.mode === "kickoff") {
      const result = await processKickoffJob(job, token);
      if (result.success) {
        try {
          await job.moveToCompleted(null, token, false);
        } catch (e) {}
      } else {
        logger.debug("Job failed", { result, mode: job.data.mode });
        await job.moveToFailed((result as any).error, token, false);
      }
    } else {
      const result = await processJob(job, token);
      if (result.success) {
        try {
          if (
            process.env.USE_DB_AUTHENTICATION === "true" &&
            (job.data.crawl_id || process.env.GCS_BUCKET_NAME)
          ) {
            logger.debug(
              "Job succeeded -- putting null in Redis",
            );
            await job.moveToCompleted(null, token, false);
          } else {
            logger.debug("Job succeeded -- putting result in Redis");
            await job.moveToCompleted(result.document, token, false);
          }
        } catch (e) {}
      } else {
        logger.debug("Job failed", { result });
        await job.moveToFailed((result as any).error, token, false);
      }
    }
  } catch (error) {
    logger.debug("Job failed", { error });
    Sentry.captureException(error);
    err = error;
    await job.moveToFailed(error, token, false);
  } finally {
    await deleteJobPriority(job.data.team_id, job.id);
    clearInterval(extendLockInterval);
  }

  return err;
};

const processExtractJobInternal = async (
  token: string,
  job: Job & { id: string },
) => {
  const logger = _logger.child({
    module: "extract-worker",
    method: "processJobInternal",
    jobId: job.id,
    extractId: job.data.extractId,
    teamId: job.data?.teamId ?? undefined,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  try {
    let result: ExtractResult | null = null;

    // const model = job.data.request.agent?.model
    // if (job.data.request.agent && model && model.toLowerCase().includes("fire-1")) {
    //   result = await performExtraction(job.data.extractId, {
    //     request: job.data.request,
    //     teamId: job.data.teamId,
    //     subId: job.data.subId,
    //   });
    // } else {
    //   result = await performExtraction_F0(job.data.extractId, {
    //     request: job.data.request,
    //     teamId: job.data.teamId,
    //     subId: job.data.subId,
    //   });
    // }
    result = await performExtraction_F0(job.data.extractId, {
      request: job.data.request,
      teamId: job.data.teamId,
      subId: job.data.subId,
    });

    if (result && result.success) {
      // Move job to completed state in Redis
      await job.moveToCompleted(result, token, false);
      return result;
    } else {
      // throw new Error(result.error || "Unknown error during extraction");

      await job.moveToCompleted(result, token, false);
      await updateExtract(job.data.extractId, {
        status: "failed",
        error:
          result?.error ??
          "Unknown error, please contact help@firecrawl.com. Extract id: " +
            job.data.extractId,
      });

      return result;
    }
  } catch (error) {
    logger.error(`🚫 Job errored ${job.id} - ${error}`, { error });

    Sentry.captureException(error, {
      data: {
        job: job.id,
      },
    });

    try {
      // Move job to failed state in Redis
      await job.moveToFailed(error, token, false);
    } catch (e) {
      logger.log("Failed to move job to failed state in Redis", { error });
    }

    await updateExtract(job.data.extractId, {
      status: "failed",
      error:
        error.error ??
        error ??
        "Unknown error, please contact help@firecrawl.com. Extract id: " +
          job.data.extractId,
    });
    return {
      success: false,
      error:
        error.error ??
        error ??
        "Unknown error, please contact help@firecrawl.com. Extract id: " +
          job.data.extractId,
    };
    // throw error;
  } finally {
    clearInterval(extendLockInterval);
  }
};

const processDeepResearchJobInternal = async (
  token: string,
  job: Job & { id: string },
) => {
  const logger = _logger.child({
    module: "deep-research-worker",
    method: "processJobInternal",
    jobId: job.id,
    researchId: job.data.researchId,
    teamId: job.data?.teamId ?? undefined,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  try {
    console.log(
      "[Deep Research] Starting deep research: ",
      job.data.researchId,
    );
    const result = await performDeepResearch({
      researchId: job.data.researchId,
      teamId: job.data.teamId,
      query: job.data.request.query,
      maxDepth: job.data.request.maxDepth,
      timeLimit: job.data.request.timeLimit,
      subId: job.data.subId,
      maxUrls: job.data.request.maxUrls,
      analysisPrompt: job.data.request.analysisPrompt,
      systemPrompt: job.data.request.systemPrompt,
      formats: job.data.request.formats,
      jsonOptions: job.data.request.jsonOptions,
    });

    if (result.success) {
      // Move job to completed state in Redis and update research status
      await job.moveToCompleted(result, token, false);
      return result;
    } else {
      // If the deep research failed but didn't throw an error
      const error = new Error("Deep research failed without specific error");
      await updateDeepResearch(job.data.researchId, {
        status: "failed",
        error: error.message,
      });
      await job.moveToFailed(error, token, false);

      return { success: false, error: error.message };
    }
  } catch (error) {
    logger.error(`🚫 Job errored ${job.id} - ${error}`, { error });

    Sentry.captureException(error, {
      data: {
        job: job.id,
      },
    });

    try {
      // Move job to failed state in Redis
      await job.moveToFailed(error, token, false);
    } catch (e) {
      logger.error("Failed to move job to failed state in Redis", { error });
    }

    await updateDeepResearch(job.data.researchId, {
      status: "failed",
      error: error.message || "Unknown error occurred",
    });

    return { success: false, error: error.message || "Unknown error occurred" };
  } finally {
    clearInterval(extendLockInterval);
  }
};

const processGenerateLlmsTxtJobInternal = async (
  token: string,
  job: Job & { id: string },
) => {
  const logger = _logger.child({
    module: "generate-llmstxt-worker",
    method: "processJobInternal",
    jobId: job.id,
    generateId: job.data.generateId,
    teamId: job.data?.teamId ?? undefined,
  });

  const extendLockInterval = setInterval(async () => {
    logger.info(`🔄 Worker extending lock on job ${job.id}`);
    await job.extendLock(token, jobLockExtensionTime);
  }, jobLockExtendInterval);

  try {
    const result = await performGenerateLlmsTxt({
      generationId: job.data.generationId,
      teamId: job.data.teamId,
      url: job.data.request.url,
      maxUrls: job.data.request.maxUrls,
      showFullText: job.data.request.showFullText,
      subId: job.data.subId,
    });

    if (result.success) {
      await job.moveToCompleted(result, token, false);
      await updateGeneratedLlmsTxt(job.data.generateId, {
        status: "completed",
        generatedText: result.data.generatedText,
        fullText: result.data.fullText,
      });
      return result;
    } else {
      const error = new Error(
        "LLMs text generation failed without specific error",
      );
      await job.moveToFailed(error, token, false);
      await updateGeneratedLlmsTxt(job.data.generateId, {
        status: "failed",
        error: error.message,
      });
      return { success: false, error: error.message };
    }
  } catch (error) {
    logger.error(`🚫 Job errored ${job.id} - ${error}`, { error });

    Sentry.captureException(error, {
      data: {
        job: job.id,
      },
    });

    try {
      await job.moveToFailed(error, token, false);
    } catch (e) {
      logger.error("Failed to move job to failed state in Redis", { error });
    }

    await updateGeneratedLlmsTxt(job.data.generateId, {
      status: "failed",
      error: error.message || "Unknown error occurred",
    });

    return { success: false, error: error.message || "Unknown error occurred" };
  } finally {
    clearInterval(extendLockInterval);
  }
};

let isShuttingDown = false;

process.on("SIGINT", () => {
  console.log("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM. Shutting down gracefully...");
  isShuttingDown = true;
});

let cantAcceptConnectionCount = 0;

const workerFun = async (
  queue: Queue,
  processJobInternal: (token: string, job: Job) => Promise<any>,
) => {
  const logger = _logger.child({ module: "queue-worker", method: "workerFun" });

  const worker = new Worker(queue.name, null, {
    connection: redisConnection,
    lockDuration: 1 * 60 * 1000, // 1 minute
    stalledInterval: 30 * 1000, // 30 seconds
    maxStalledCount: 10, // 10 times
  });

  worker.startStalledCheckTimer();

  const monitor = await systemMonitor;
  let lastGcTime = Date.now();
  const GC_INTERVAL = 5 * 60 * 1000; // 5 minutes
  const MEMORY_THRESHOLD = 0.85; // 85% memory usage

  // Function to perform garbage collection
  const performGc = async () => {
    const now = Date.now();
    if (now - lastGcTime < GC_INTERVAL) return;

    const memoryUsage = await monitor.checkMemoryUsage();
    if (memoryUsage > MEMORY_THRESHOLD) {
      logger.info("Performing garbage collection due to high memory usage", {
        memoryUsage,
        threshold: MEMORY_THRESHOLD
      });
      
      // Force garbage collection
      if (global.gc) {
        global.gc();
      }
      
      // Clean up Playwright instances
      try {
        const response = await fetch(`${process.env.PLAYWRIGHT_MICROSERVICE_URL}/cleanup`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        });
        if (!response.ok) {
          logger.error("Failed to cleanup Playwright instances", {
            status: response.status,
            statusText: response.statusText
          });
        }
      } catch (error) {
        logger.error("Error cleaning up Playwright instances", { error });
      }
      
      lastGcTime = now;
    }
  };

  while (true) {
    if (isShuttingDown) {
      console.log("No longer accepting new jobs. SIGINT");
      break;
    }

    // Check memory and perform GC if needed
    await performGc();

    const token = uuidv4();
    const canAcceptConnection = await monitor.acceptConnection();
    if (!canAcceptConnection) {
      console.log("Can't accept connection due to RAM/CPU load");
      logger.info("Can't accept connection due to RAM/CPU load");
      cantAcceptConnectionCount++;

      if (cantAcceptConnectionCount >= 25) {
        logger.error("WORKER STALLED", {
          cpuUsage: await monitor.checkCpuUsage(),
          memoryUsage: await monitor.checkMemoryUsage(),
        });
        
        // Force garbage collection when stalled
        if (global.gc) {
          global.gc();
        }
      }

      await sleep(cantAcceptConnectionInterval);
      continue;
    } else {
      cantAcceptConnectionCount = 0;
    }

    const job = await worker.getNextJob(token);
    if (job) {
      if (job.id) {
        runningJobs.add(job.id);
      }

      async function afterJobDone(job: Job<any, any, string>) {
        if (job.id) {
          runningJobs.delete(job.id);
        }

        if (job.id && job.data && job.data.team_id) {
          await removeConcurrencyLimitActiveJob(job.data.team_id, job.id);
          cleanOldConcurrencyLimitEntries(job.data.team_id);

          // Queue up next job, if it exists
          // No need to check if we're under the limit here -- if the current job is finished,
          // we are 1 under the limit, assuming the job insertion logic never over-inserts. - MG
          const nextJob = await takeConcurrencyLimitedJob(job.data.team_id);
          if (nextJob !== null) {
            await pushConcurrencyLimitActiveJob(
              job.data.team_id,
              nextJob.id,
              60 * 1000,
            ); // 60s initial timeout

            await queue.add(
              nextJob.id,
              {
                ...nextJob.data,
                concurrencyLimitHit: true,
              },
              {
                ...nextJob.opts,
                jobId: nextJob.id,
                priority: nextJob.priority,
              },
            );
          }
        }
      }

      if (job.data && job.data.sentry && Sentry.isInitialized()) {
        Sentry.continueTrace(
          {
            sentryTrace: job.data.sentry.trace,
            baggage: job.data.sentry.baggage,
          },
          () => {
            Sentry.startSpan(
              {
                name: "Scrape job",
                attributes: {
                  job: job.id,
                  worker: process.env.FLY_MACHINE_ID ?? worker.id,
                },
              },
              async (span) => {
                await Sentry.startSpan(
                  {
                    name: "Process scrape job",
                    op: "queue.process",
                    attributes: {
                      "messaging.message.id": job.id,
                      "messaging.destination.name": getScrapeQueue().name,
                      "messaging.message.body.size": job.data.sentry.size,
                      "messaging.message.receive.latency":
                        Date.now() - (job.processedOn ?? job.timestamp),
                      "messaging.message.retry.count": job.attemptsMade,
                    },
                  },
                  async () => {
                    let res;
                    try {
                      res = await processJobInternal(token, job);
                    } finally {
                      await afterJobDone(job);
                    }

                    if (res !== null) {
                      span.setStatus({ code: 2 }); // ERROR
                    } else {
                      span.setStatus({ code: 1 }); // OK
                    }
                  },
                );
              },
            );
          },
        );
      } else {
        Sentry.startSpan(
          {
            name: "Scrape job",
            attributes: {
              job: job.id,
              worker: process.env.FLY_MACHINE_ID ?? worker.id,
            },
          },
          () => {
            processJobInternal(token, job).finally(() => afterJobDone(job));
          },
        );
      }

      await sleep(gotJobInterval);
    } else {
      await sleep(connectionMonitorInterval);
    }
  }
};

async function processKickoffJob(job: Job & { id: string }, token: string) {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processKickoffJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    teamId: job.data?.team_id ?? undefined,
  });

  try {
    const sc = (await getCrawl(job.data.crawl_id)) as StoredCrawl;
    const crawler = crawlToCrawler(job.data.crawl_id, sc);

    logger.debug("Locking URL...");
    await lockURL(job.data.crawl_id, sc, job.data.url);
    const jobId = uuidv4();
    logger.debug("Adding scrape job to Redis...", { jobId });
    await addScrapeJob(
      {
        url: job.data.url,
        mode: "single_urls",
        team_id: job.data.team_id,
        crawlerOptions: job.data.crawlerOptions,
        scrapeOptions: scrapeOptions.parse(job.data.scrapeOptions),
        internalOptions: sc.internalOptions,
        origin: job.data.origin,
        crawl_id: job.data.crawl_id,
        webhook: job.data.webhook,
        v1: job.data.v1,
        isCrawlSourceScrape: true,
      },
      {
        priority: 15,
      },
      jobId,
    );
    logger.debug("Adding scrape job to BullMQ...", { jobId });
    await addCrawlJob(job.data.crawl_id, jobId);

    if (job.data.webhook) {
      logger.debug("Calling webhook with crawl.started...", {
        webhook: job.data.webhook,
      });
      await callWebhook(
        job.data.team_id,
        job.data.crawl_id,
        null,
        job.data.webhook,
        true,
        "crawl.started",
      );
    }

    const sitemap = sc.crawlerOptions.ignoreSitemap
      ? 0
      : await crawler.tryGetSitemap(async (urls) => {
          if (urls.length === 0) return;

          logger.debug("Using sitemap chunk of length " + urls.length, {
            sitemapLength: urls.length,
          });

          let jobPriority = await getJobPriority({
            team_id: job.data.team_id,
            basePriority: 21,
          });
          logger.debug("Using job priority " + jobPriority, { jobPriority });

          const jobs = urls.map((url) => {
            const uuid = uuidv4();
            return {
              name: uuid,
              data: {
                url,
                mode: "single_urls" as const,
                team_id: job.data.team_id,
                crawlerOptions: job.data.crawlerOptions,
                scrapeOptions: job.data.scrapeOptions,
                internalOptions: sc.internalOptions,
                origin: job.data.origin,
                crawl_id: job.data.crawl_id,
                sitemapped: true,
                webhook: job.data.webhook,
                v1: job.data.v1,
              },
              opts: {
                jobId: uuid,
                priority: 20,
              },
            };
          });

          logger.debug("Locking URLs...");
          const lockedIds = await lockURLsIndividually(
            job.data.crawl_id,
            sc,
            jobs.map((x) => ({ id: x.opts.jobId, url: x.data.url })),
          );
          const lockedJobs = jobs.filter((x) =>
            lockedIds.find((y) => y.id === x.opts.jobId),
          );
          logger.debug("Adding scrape jobs to Redis...");
          await addCrawlJobs(
            job.data.crawl_id,
            lockedJobs.map((x) => x.opts.jobId),
          );
          logger.debug("Adding scrape jobs to BullMQ...");
          await addScrapeJobs(lockedJobs);
        });

    if (sitemap === 0) {
      logger.debug("Sitemap not found or ignored.", {
        ignoreSitemap: sc.crawlerOptions.ignoreSitemap,
      });
    }

    logger.debug("Done queueing jobs!");

    await finishCrawlKickoff(job.data.crawl_id);
    await finishCrawlIfNeeded(job, sc);

    return { success: true };
  } catch (error) {
    logger.error("An error occurred!", { error });
    await finishCrawlKickoff(job.data.crawl_id);
    const sc = (await getCrawl(job.data.crawl_id))!;
    if (sc) {
      await finishCrawlIfNeeded(job, sc);
    }
    return { success: false, error };
  }
}

async function indexJob(job: Job & { id: string }, document: Document) {
  if (
    document &&
    document.markdown &&
    job.data.team_id === process.env.BACKGROUND_INDEX_TEAM_ID!
  ) {
    // indexPage({
    //   document: document,
    //   originUrl: job.data.crawl_id
    //     ? (await getCrawl(job.data.crawl_id))?.originUrl!
    //     : document.metadata.sourceURL!,
    //   crawlId: job.data.crawl_id,
    //   teamId: job.data.team_id,
    // }).catch((error) => {
    //   _logger.error("Error indexing page", { error });
    // });
  }
}

async function processJob(job: Job & { id: string }, token: string) {
  const logger = _logger.child({
    module: "queue-worker",
    method: "processJob",
    jobId: job.id,
    scrapeId: job.id,
    crawlId: job.data?.crawl_id ?? undefined,
    teamId: job.data?.team_id ?? undefined,
  });
  logger.info(`🐂 Worker taking job ${job.id}`, { url: job.data.url });
  const start = Date.now();
  
  // Define sc at the top level of the function so it's available in all blocks
  let currentCrawlData: StoredCrawl | null = null;

  try {
    job.updateProgress({
      current: 1,
      total: 100,
      current_step: "SCRAPING",
      current_url: "",
    });

    if (job.data.crawl_id) {
      currentCrawlData = (await getCrawl(job.data.crawl_id))!;
      if (currentCrawlData && currentCrawlData.cancelled) {
        throw new Error("Parent crawl/batch scrape was cancelled");
      }

      // Initialize backup service for new crawls
      if (job.data.crawl_id !== currentCrawlId) {
        currentCrawlId = job.data.crawl_id;
        const domain = new URL(currentCrawlData.originUrl!).hostname;
        await backupService.initializeBackup(job.data.crawl_id, domain);
      }
    }

    const pipeline = await Promise.race([
      startWebScraperPipeline({
        job,
        token,
      }),
      ...(job.data.scrapeOptions.timeout !== undefined
        ? [
            (async () => {
              await sleep(job.data.scrapeOptions.timeout);
              throw new Error("timeout");
            })(),
          ]
        : []),
    ]);

    if (!pipeline.success) {
      throw pipeline.error;
    }

    const end = Date.now();
    const timeTakenInSeconds = (end - start) / 1000;

    const doc = pipeline.document;

    const rawHtml = doc.rawHtml ?? "";

    if (!job.data.scrapeOptions.formats.includes("rawHtml")) {
      delete doc.rawHtml;
    }

    if (job.data.concurrencyLimited) {
      doc.warning =
        "This scrape job was throttled at your current concurrency limit. If you'd like to scrape faster, you can upgrade your plan." +
        (doc.warning ? " " + doc.warning : "");
    }

    const data = {
      success: true,
      result: {
        links: [
          {
            content: doc,
            source: doc?.metadata?.sourceURL ?? doc?.metadata?.url ?? "",
            id: job.id,
          },
        ],
      },
      project_id: job.data.project_id,
      document: doc,
    };

    if (job.data.webhook && job.data.mode !== "crawl" && job.data.v1) {
      logger.debug("Calling webhook with success...", {
        webhook: job.data.webhook,
      });
      await callWebhook(
        job.data.team_id,
        job.data.crawl_id,
        data,
        job.data.webhook,
        job.data.v1,
        job.data.crawlerOptions !== null ? "crawl.page" : "batch_scrape.page",
        true,
      );
    }

    if (job.data.crawl_id) {
      const sc = (await getCrawl(job.data.crawl_id))!;

      if (
        doc.metadata.url !== undefined &&
        doc.metadata.sourceURL !== undefined &&
        normalizeURL(doc.metadata.url, sc) !==
          normalizeURL(doc.metadata.sourceURL, sc) &&
        job.data.crawlerOptions !== null // only on crawls, don't care on batch scrape
      ) {
        const crawler = crawlToCrawler(job.data.crawl_id, sc);
        if (
          crawler.filterURL(doc.metadata.url, doc.metadata.sourceURL) ===
            null &&
          !job.data.isCrawlSourceScrape
        ) {
          throw new Error(
            "Redirected target URL is not allowed by crawlOptions",
          ); // TODO: make this its own error type that is ignored by error tracking
        }

        // Only re-set originUrl if it's different from the current hostname
        // This is only done on this condition to handle cross-domain redirects
        // If this would be done for non-crossdomain redirects, but also for e.g.
        // redirecting / -> /introduction (like our docs site does), it would
        // break crawling the entire site without allowBackwardsCrawling - mogery
        const isHostnameDifferent =
          normalizeUrlOnlyHostname(doc.metadata.url) !==
          normalizeUrlOnlyHostname(doc.metadata.sourceURL);
        if (job.data.isCrawlSourceScrape && isHostnameDifferent) {
          // TODO: re-fetch sitemap for redirect target domain
          sc.originUrl = doc.metadata.url;
          await saveCrawl(job.data.crawl_id, sc);
        }

        if (isUrlBlocked(doc.metadata.url)) {
          throw new Error(BLOCKLISTED_URL_MESSAGE); // TODO: make this its own error type that is ignored by error tracking
        }

        const p1 = generateURLPermutations(normalizeURL(doc.metadata.url, sc));
        const p2 = generateURLPermutations(
          normalizeURL(doc.metadata.sourceURL, sc),
        );

        if (JSON.stringify(p1) !== JSON.stringify(p2)) {
          logger.debug(
            "Was redirected, removing old URL and locking new URL...",
            { oldUrl: doc.metadata.sourceURL, newUrl: doc.metadata.url },
          );

          // Prevent redirect target from being visited in the crawl again
          // See lockURL
          const x = await redisConnection.sadd(
            "crawl:" + job.data.crawl_id + ":visited",
            ...p1.map((x) => x.href),
          );
          const lockRes = x === p1.length;

          if (job.data.crawlerOptions !== null && !lockRes) {
            throw new RacedRedirectError();
          }
        }
      }

      logger.debug("Logging job to DB...");
      await logJob(
        {
          job_id: job.id as string,
          success: true,
          num_docs: 1,
          docs: [doc],
          time_taken: timeTakenInSeconds,
          team_id: job.data.team_id,
          mode: job.data.mode,
          url: job.data.url,
          crawlerOptions: sc.crawlerOptions,
          scrapeOptions: job.data.scrapeOptions,
          origin: job.data.origin,
          crawl_id: job.data.crawl_id,
        },
        true,
      );

      indexJob(job, doc);

      logger.debug("Declaring job as done...");
      await addCrawlJobDone(job.data.crawl_id, job.id, true);

      // Check for backup after job completion
      await backupService.checkAndBackup();

      if (job.data.crawlerOptions !== null) {
        if (!sc.cancelled) {
          // Explicitly type assert currentCrawlData as StoredCrawl to satisfy the type checker
          // This is safe because we've checked it's not null above
          const currentCrawlDataNonNull = currentCrawlData as StoredCrawl;
          
          const crawler = crawlToCrawler(
            job.data.crawl_id,
            currentCrawlDataNonNull,
            doc.metadata.url ?? doc.metadata.sourceURL ?? currentCrawlDataNonNull.originUrl!,
            job.data.crawlerOptions
          );

          const links = crawler.filterLinks(
            await crawler.extractLinksFromHTML(
              rawHtml ?? "",
              doc.metadata?.url ?? doc.metadata?.sourceURL ?? currentCrawlDataNonNull.originUrl!,
            ),
            Infinity,
            sc.crawlerOptions?.maxDepth ?? 10,
          );
          logger.debug("Discovered " + links.length + " links...", {
            linksLength: links.length,
          });

          for (const link of links) {
            // Normalize the discovered link with currentCrawlData
            const normalizedLink = normalizeURL(link, currentCrawlDataNonNull);

            let existsResult: unknown;
            try {
                existsResult = await redisConnection.call('BF.EXISTS', GLOBAL_VISITED_KEY, Buffer.from(normalizedLink));
            } catch (bfExistsError) {
                logger.error('Bloom filter check failed', { url: normalizedLink, error: bfExistsError.message });
                Sentry.captureException(bfExistsError);
            }

            // Type check the result
            const exists = typeof existsResult === 'number' ? existsResult : 0;

            if (exists === 1) {
                logger.debug(`Skipping already visited URL (Bloom Filter): ${normalizedLink}`);
                continue;
            }

            // Check original lockURL if still needed for other reasons, otherwise remove/simplify
            if (await lockURL(job.data.crawl_id, sc, link)) {
              const jobPriority = await getJobPriority({
                team_id: sc.team_id,
                basePriority: job.data.crawl_id ? 20 : 10,
              });
              const jobId = uuidv4();

              logger.debug(
                "Determined job priority " +
                  jobPriority +
                  " for URL " +
                  JSON.stringify(link),
                { jobPriority, url: link },
              );

              await addScrapeJob(
                {
                  url: link,
                  mode: "single_urls",
                  team_id: sc.team_id,
                  scrapeOptions: scrapeOptions.parse(sc.scrapeOptions),
                  internalOptions: sc.internalOptions,
                  crawlerOptions: {
                    ...sc.crawlerOptions,
                    currentDiscoveryDepth:
                      (job.data.crawlerOptions?.currentDiscoveryDepth ?? 0) + 1,
                  },
                  origin: job.data.origin,
                  crawl_id: job.data.crawl_id,
                  webhook: job.data.webhook,
                  v1: job.data.v1,
                },
                {},
                jobId,
                jobPriority,
              );

              await addCrawlJob(job.data.crawl_id, jobId);
              logger.debug("Added job for URL " + JSON.stringify(link), {
                jobPriority,
                url: link,
                newJobId: jobId,
              });
            } else {
              // logger.debug("Could not lock URL " + JSON.stringify(link)); // Might be redundant if BF caught it
            }
          }

          // Only run check after adding new jobs for discovery - mogery
          if (
            job.data.isCrawlSourceScrape &&
            crawler.filterLinks(
              [doc.metadata.url ?? doc.metadata.sourceURL!],
              1,
              sc.crawlerOptions?.maxDepth ?? 10,
            ).length === 0
          ) {
            throw new Error(
              "Source URL is not allowed by includePaths/excludePaths rules",
            );
          }
        }
      }

      await finishCrawlIfNeeded(job, sc);
    } else {
      const cost_tracking = doc?.metadata?.costTracking;

      delete doc.metadata.costTracking;
      
      await logJob({
        job_id: job.id,
        success: true,
        message: "Scrape completed",
        num_docs: 1,
        docs: [doc],
        time_taken: timeTakenInSeconds,
        team_id: job.data.team_id,
        mode: "scrape",
        url: job.data.url,
        scrapeOptions: job.data.scrapeOptions,
        origin: job.data.origin,
        num_tokens: 0, // TODO: fix
        cost_tracking,
      });
      
      indexJob(job, doc);
    }

    if (job.data.is_scrape !== true) {
      let creditsToBeBilled = 1; // Assuming 1 credit per document
      if (job.data.scrapeOptions.extract) {
        creditsToBeBilled = 5;
      }
      if (job.data.scrapeOptions.agent?.model?.toLowerCase() === "fire-1") {
        creditsToBeBilled = 150;
      }

      if (
        job.data.team_id !== process.env.BACKGROUND_INDEX_TEAM_ID! &&
        process.env.USE_DB_AUTHENTICATION === "true"
      ) {
        try {
          const billingJobId = uuidv4();
          logger.debug(
            `Adding billing job to queue for team ${job.data.team_id}`,
            {
              billingJobId,
              credits: creditsToBeBilled,
              is_extract: false,
            },
          );

          // Add directly to the billing queue - the billing worker will handle the rest
          await getBillingQueue().add(
            "bill_team",
            {
              team_id: job.data.team_id,
              subscription_id: undefined,
              credits: creditsToBeBilled,
              is_extract: false,
              timestamp: new Date().toISOString(),
              originating_job_id: job.id,
            },
            {
              jobId: billingJobId,
              priority: 10,
            },
          );
        } catch (error) {
          logger.error(
            `Failed to add billing job to queue for team ${job.data.team_id} for ${creditsToBeBilled} credits`,
            { error },
          );
          Sentry.captureException(error);
        }
      }
    }

    logger.info(`🐂 Job done ${job.id}`);

    // --- ADD BF.ADD after successful scrape ---
    // Find a suitable place *after* success is confirmed and *before* returning
    // Example: Inside the main try block, after pipeline success, before return data

    if (pipeline.success) {
         try {
             const urlToAdd = doc.metadata?.url ?? doc.metadata?.sourceURL ?? job.data.url;
             let normalizedUrlToAdd: string | null = null;
             
             // Use the currentCrawlData from function scope
             if (currentCrawlData) {
                 normalizedUrlToAdd = normalizeURL(urlToAdd, currentCrawlData);
             } else {
                 try {
                    normalizedUrlToAdd = new URL(urlToAdd).toString();
                 } catch (e) { 
                     logger.warn('Invalid URL for basic normalization', { urlToAdd }); 
                 }
             }

             if (normalizedUrlToAdd) {
                 await redisConnection.call('BF.ADD', GLOBAL_VISITED_KEY, Buffer.from(normalizedUrlToAdd));
                 logger.debug(`Added URL to Bloom filter: ${normalizedUrlToAdd}`);
             } else {
                 logger.warn('Could not determine normalized URL to add to Bloom filter', { jobId: job.id, urlToAdd });
             }
         } catch (bfAddError) {
             logger.error('Failed to add URL to Bloom filter', { jobId: job.id, error: bfAddError.message });
             Sentry.captureException(bfAddError);
         }
    }
    // --- END BF.ADD ---

    return data;
  } catch (error) {
    if (job.data.crawl_id) {
      const sc = (await getCrawl(job.data.crawl_id))!;

      logger.debug("Declaring job as done...");
      await addCrawlJobDone(job.data.crawl_id, job.id, false);
      await redisConnection.srem(
        "crawl:" + job.data.crawl_id + ":visited_unique",
        normalizeURL(job.data.url, sc),
      );

      await finishCrawlIfNeeded(job, sc);
    }

    const isEarlyTimeout =
      error instanceof Error && error.message === "timeout";
    const isCancelled =
      error instanceof Error &&
      error.message === "Parent crawl/batch scrape was cancelled";

    if (isEarlyTimeout) {
      logger.error(`🐂 Job timed out ${job.id}`);
    } else if (error instanceof RacedRedirectError) {
      logger.warn(`🐂 Job got redirect raced ${job.id}, silently failing`);
    } else if (isCancelled) {
      logger.warn(`🐂 Job got cancelled, silently failing`);
    } else {
      logger.error(`🐂 Job errored ${job.id} - ${error}`, { error });

      Sentry.captureException(error, {
        data: {
          job: job.id,
        },
      });

      if (error instanceof CustomError) {
        // Here we handle the error, then save the failed job
        logger.error(error.message); // or any other error handling
      }
      logger.error(error);
      if (error.stack) {
        logger.error(error.stack);
      }
    }

    const data = {
      success: false,
      document: null,
      project_id: job.data.project_id,
      error:
        error instanceof Error
          ? error
          : typeof error === "string"
            ? new Error(error)
            : new Error(JSON.stringify(error)),
    };

    if (!job.data.v1 && (job.data.mode === "crawl" || job.data.crawl_id)) {
      callWebhook(
        job.data.team_id,
        job.data.crawl_id ?? (job.id as string),
        data,
        job.data.webhook,
        job.data.v1,
        job.data.crawlerOptions !== null ? "crawl.page" : "batch_scrape.page",
      );
    }

    const end = Date.now();
    const timeTakenInSeconds = (end - start) / 1000;

    logger.debug("Logging job to DB...");
    await logJob(
      {
        job_id: job.id as string,
        success: false,
        message:
          typeof error === "string"
            ? error
            : (error.message ??
              "Something went wrong... Contact help@mendable.ai"),
        num_docs: 0,
        docs: [],
        time_taken: timeTakenInSeconds,
        team_id: job.data.team_id,
        mode: job.data.mode,
        url: job.data.url,
        crawlerOptions: job.data.crawlerOptions,
        scrapeOptions: job.data.scrapeOptions,
        origin: job.data.origin,
        crawl_id: job.data.crawl_id,
      },
      true,
    );
    return data;
  }
}

// wsq.process(
//   Math.floor(Number(process.env.NUM_WORKERS_PER_QUEUE ?? 8)),
//   processJob
// );

// wsq.on("waiting", j => ScrapeEvents.logJobEvent(j, "waiting"));
// wsq.on("active", j => ScrapeEvents.logJobEvent(j, "active"));
// wsq.on("completed", j => ScrapeEvents.logJobEvent(j, "completed"));
// wsq.on("paused", j => ScrapeEvents.logJobEvent(j, "paused"));
// wsq.on("resumed", j => ScrapeEvents.logJobEvent(j, "resumed"));
// wsq.on("removed", j => ScrapeEvents.logJobEvent(j, "removed"));

// Start all workers
(async () => {
  // +++ Load Bloom Filter +++
  await initializeBloomFilter();
  // +++ Start Periodic Saving +++
  const bloomSaveTimer = setInterval(saveBloomFilter, BLOOM_SAVE_INTERVAL);

  await Promise.all([
    workerFun(getScrapeQueue(), processJobInternal),
    workerFun(getExtractQueue(), processExtractJobInternal),
    workerFun(getDeepResearchQueue(), processDeepResearchJobInternal),
    workerFun(getGenerateLlmsTxtQueue(), processGenerateLlmsTxtJobInternal),
  ]);

  console.log("All workers exited. Waiting for all jobs to finish...");

  while (runningJobs.size > 0) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log("All jobs finished. Worker out!");

  // Graceful Shutdown handling
  process.on('SIGINT', async () => {
    console.log("Received SIGINT. Shutting down gracefully...");
    isShuttingDown = true;
    clearInterval(bloomSaveTimer); // Stop saving timer
    await saveBloomFilter(); // Perform final save
    // ... existing shutdown logic ...
    process.exit(0); // Ensure exit after cleanup
  });
  process.on('SIGTERM', async () => {
     console.log("Received SIGTERM. Shutting down gracefully...");
     isShuttingDown = true;
     clearInterval(bloomSaveTimer);
     await saveBloomFilter(); // Perform final save
     // ... existing shutdown logic ...
     process.exit(0);
  });
})();
