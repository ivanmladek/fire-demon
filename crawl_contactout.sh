#!/bin/bash

# Crawl ContactOut profile pages
curl -X POST http://localhost:3002/v1/crawl \
-H "Content-Type: application/json" \
-d '{
  "url": "https://contactout.com/don-burke-36416",
  "allowBackwardLinks": true,
  "limit": 1000,
  "maxDepth": 10,
  "ignoreSitemap": true,
  "excludePaths": [
    "^https://contactout\\.com/?$",
    "/alternative",
    "/api-feature",
    "/blog",
    "/celebrity-directory",
    "/chrome-extension",
    "/clients",
    "/company-directory",
    "/company/.*-email-format-",
    "/contact",
    "/cdn-cgi/",
    "/data-enrichment-feature",
    "/email-campaigns",
    "/email-lists",
    "/email_verifier",
    "/famous-people-directory",
    "/free-tools",
    "/gmail-enrichment-feature",
    "/integrations-feature",
    "/login",
    "/meeting",
    "/our-data",
    "/optout",
    "/password/reset",
    "/pricing",
    "/privacy",
    "/privacy_policy",
    "/recruiters",
    "/register",
    "/sales-prospecting",
    "/sales-users",
    "/search-portal",
    "/terms"
  ],
  "scrapeOptions": {
    "formats": ["markdown"],
    "blockAds": true,
    "onlyMainContent": true,
    "excludeTags": ["img"]
  }
}' 