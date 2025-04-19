import { Browser } from "playwright";
import logger from "./logger";

let browser: Browser | null = null;

export const setBrowser = (b: Browser) => {
  browser = b;
};

export const cleanupBrowser = async () => {
  try {
    if (browser) {
      logger.info("Closing browser and cleaning up resources");
      await browser.close();
      browser = null;
    }
  } catch (error) {
    logger.error("Error during browser cleanup", { error });
    throw error;
  }
}; 