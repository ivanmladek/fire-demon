import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import { chromium, Browser, BrowserContext, Route, Request as PlaywrightRequest, Page } from 'playwright';
import dotenv from 'dotenv';
import UserAgent from 'user-agents';
import { getError } from './helpers/get_error';
import { v4 as uuidv4 } from "uuid";
import cors from "cors";
import logger from './logger';
import { cleanupBrowser } from "./cleanup";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

const BLOCK_MEDIA = (process.env.BLOCK_MEDIA || 'False').toUpperCase() === 'TRUE';

// Proxy configuration
const proxyConfig: {
  server: string;
  username: string;
  password: string;
  rotationEnabled: boolean;
  rotationInterval: number;
  retryCount: number;
  retryDelay: number;
} = {
  server: process.env.PROXY_SERVER || '',
  username: process.env.PROXY_USERNAME || '',
  password: process.env.PROXY_PASSWORD || '',
  rotationEnabled: process.env.PROXY_ROTATION_ENABLED === 'true',
  rotationInterval: parseInt(process.env.PROXY_ROTATION_INTERVAL || '1'),
  retryCount: parseInt(process.env.PROXY_RETRY_COUNT || '5'),
  retryDelay: parseInt(process.env.PROXY_RETRY_DELAY || '15000'),
};

const AD_SERVING_DOMAINS = [
  'doubleclick.net',
  'adservice.google.com',
  'googlesyndication.com',
  'googletagservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adsystem.com',
  'adservice.com',
  'adnxs.com',
  'ads-twitter.com',
  'facebook.net',
  'fbcdn.net',
  'amazon-adsystem.com',
  'images.contactout.com',
  'challenges.cloudflare.com',
  'script.hotjar.com',
  'cdnjs.cloudflare.com',
  's3-us-west-1.amazonaws.com',
  'static.hotjar.com',
  'accounts.google.com',
  'fonts.googleapis.com',
  'encrypted-tbn0.gstatic.com'
];

interface UrlModel {
  url: string;
  wait_after_load?: number;
  timeout?: number;
  headers?: { [key: string]: string };
  check_selector?: string;
}

// Browser instance
let browser: any = null;

const initializeBrowser = async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ],
    proxy: proxyConfig
  });
  logger.info('Browser initialized successfully');
};

const createContext = async () => {
  const userAgent = new UserAgent().toString();
  const viewport = { width: 1280, height: 800 };

  const contextOptions: any = {
    userAgent,
    viewport,
  };

  if (proxyConfig.server) {
    console.log(`[Proxy Check] Creating context WITH proxy: Server=${proxyConfig.server}, Username=${proxyConfig.username}`);
  } else {
    console.log(`[Proxy Check] Creating context WITHOUT proxy.`);
  }

  const context = await browser.newContext(contextOptions);

  if (BLOCK_MEDIA) {
    await context.route('**/*.{png,jpg,jpeg,gif,svg,mp3,mp4,avi,flac,ogg,wav,webm}', async (route: Route, request: PlaywrightRequest) => {
      await route.abort();
    });
  }

  // Intercept all requests to avoid loading ads
  await context.route('**/*', (route: Route, request: PlaywrightRequest) => {
    const requestUrl = new URL(request.url());
    const hostname = requestUrl.hostname;

    if (AD_SERVING_DOMAINS.some(domain => hostname.includes(domain))) {
      return route.abort();
    }
    return route.continue();
  });

  return context;
};

const shutdownBrowser = async () => {
  if (browser) {
    await browser.close();
  }
};

const isValidUrl = (urlString: string): boolean => {
  try {
    new URL(urlString);
    return true;
  } catch (_) {
    return false;
  }
};

const scrapePage = async (page: Page, url: string, waitUntil: 'load' | 'networkidle', waitAfterLoad: number, timeout: number, checkSelector: string | undefined) => {
  console.log(`Navigating to ${url} with waitUntil: ${waitUntil} and timeout: ${timeout}ms`);
  const response = await page.goto(url, { waitUntil, timeout });

  if (waitAfterLoad > 0) {
    await page.waitForTimeout(waitAfterLoad);
  }

  if (checkSelector) {
    try {
      await page.waitForSelector(checkSelector, { timeout });
    } catch (error) {
      throw new Error('Required selector not found');
    }
  }

  let headers = null, content = await page.content();
  if (response) {
    headers = await response.allHeaders();
    const ct = Object.entries(headers).find(x => x[0].toLowerCase() === "content-type");
    if (ct && (ct[1].includes("application/json") || ct[1].includes("text/plain"))) {
      content = (await response.body()).toString("utf8"); // TODO: determine real encoding
    }
  }

  return {
    content,
    status: response ? response.status() : null,
    headers,
  };
};

const rotateProxy = async () => {
  if (!proxyConfig.rotationEnabled) return;
  
  // Implement proxy rotation logic here
  // This could involve:
  // 1. Using a proxy pool
  // 2. Changing proxy credentials
  // 3. Waiting for rate limit reset
  console.log('Rotating proxy...');
  await new Promise(resolve => setTimeout(resolve, proxyConfig.retryDelay));
};

interface ScrapeError extends Error {
  status?: number;
}

const scrapeWithRetry = async (page: Page, url: string, waitUntil: 'load' | 'networkidle', waitAfterLoad: number, timeout: number, checkSelector: string | undefined, retryCount: number = proxyConfig.retryCount) => {
  for (let attempt = 0; attempt < retryCount; attempt++) {
    try {
      const result = await scrapePage(page, url, waitUntil, waitAfterLoad, timeout, checkSelector);
      
      if (result.status === 429) {
        console.log(`Rate limited (429) on attempt ${attempt + 1}/${retryCount}`);
        await rotateProxy();
        continue;
      }
      
      return result;
    } catch (error: unknown) {
      const err = error as ScrapeError;
      console.log(`Attempt ${attempt + 1}/${retryCount} failed:`, err.message);
      
      if (attempt < retryCount - 1) {
        await rotateProxy();
      } else {
        throw err;
      }
    }
  }
  
  throw new Error('Max retries exceeded');
};

app.post('/scrape', async (req: Request, res: Response) => {
  const { url, wait_after_load = 0, timeout = 15000, headers, check_selector }: UrlModel = req.body;

  console.log(`================= Scrape Request =================`);
  console.log(`URL: ${url}`);
  console.log(`Wait After Load: ${wait_after_load}`);
  console.log(`Timeout: ${timeout}`);
  console.log(`Headers: ${headers ? JSON.stringify(headers) : 'None'}`);
  console.log(`Check Selector: ${check_selector ? check_selector : 'None'}`);
  console.log(`==================================================`);

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!isValidUrl(url)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!proxyConfig.server) {
    console.warn('⚠️ WARNING: No proxy server provided. Your IP address may be blocked.');
  }

  if (!browser) {
    await initializeBrowser();
  }

  const context = await createContext();
  const page = await context.newPage();

  // Set headers if provided
  if (headers) {
    await page.setExtraHTTPHeaders(headers);
  }

  let result: Awaited<ReturnType<typeof scrapePage>>;
  try {
    // Try both strategies with retries
    try {
      console.log('Attempting strategy 1: Normal load');
      result = await scrapeWithRetry(page, url, 'load', wait_after_load, timeout, check_selector);
    } catch (error: unknown) {
      const err = error as ScrapeError;
      console.log('Strategy 1 failed, attempting strategy 2: Wait until networkidle');
      result = await scrapeWithRetry(page, url, 'networkidle', wait_after_load, timeout, check_selector);
    }
  } catch (finalError: unknown) {
    const err = finalError as ScrapeError;
    await page.close();
    await context.close();
    return res.status(500).json({ 
      error: 'An error occurred while fetching the page.',
      details: err.message,
      status: err.status || 500
    });
  }

  const pageError = result.status !== 200 ? getError(result.status) : undefined;

  if (!pageError) {
    console.log(`✅ Scrape successful!`);
  } else {
    console.log(`🚨 Scrape failed with status code: ${result.status} ${pageError}`);
  }

  await page.close();
  await context.close();

  return res.json({
    content: result.content,
    pageStatusCode: result.status,
    pageError,
    headers: result.headers
  });
});

// Add cleanup endpoint
app.post("/cleanup", async (req, res) => {
  try {
    logger.info("Cleaning up Playwright instances");
    await cleanupBrowser();
    res.status(200).json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error("Error during cleanup", { error: err });
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  initializeBrowser().then(() => {
    console.log(`Server is running on port ${PORT}`);
  });
});

process.on('SIGINT', () => {
  shutdownBrowser().then(() => {
    console.log('Browser closed');
    process.exit(0);
  });
});
