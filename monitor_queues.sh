#!/bin/bash

while true; do
    echo "=== $(date) ==="
    echo "Crawl Queue Events:"
    docker exec firecrawl-redis-1 redis-cli XRANGE bull:{crawlQueue}:events - + COUNT 5
    echo -e "\nCrawl Queue Active Jobs:"
    docker exec firecrawl-redis-1 redis-cli LRANGE bull:{crawlQueue}:active 0 -1
    echo -e "\nCrawl Queue Waiting Jobs:"
    docker exec firecrawl-redis-1 redis-cli LRANGE bull:{crawlQueue}:wait 0 -1
    echo -e "\nScrape Queue Events:"
    docker exec firecrawl-redis-1 redis-cli XRANGE bull:{scrapeQueue}:events - + COUNT 5
    echo -e "\nScrape Queue Active Jobs:"
    docker exec firecrawl-redis-1 redis-cli LRANGE bull:{scrapeQueue}:active 0 -1
    echo -e "\nScrape Queue Waiting Jobs:"
    docker exec firecrawl-redis-1 redis-cli LRANGE bull:{scrapeQueue}:wait 0 -1
    echo -e "\n----------------------------------------\n"
    sleep 2
done 