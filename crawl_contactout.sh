#!/bin/bash

# Crawl ContactOut profile pages
curl -X POST http://localhost:3002/v1/crawl \
-H "Authorization: Bearer test-api-key-123" \
-H "Content-Type: application/json" \
-d '{
  "url": "https://contactout.com/Amber-Badgett-53430",
  "allowBackwardLinks": true,
  "limit": 5000,
  "maxDepth": 10,
  "allowExternalLinks": false,
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
    "removeBase64Images": true,
    "blockAds": true,
    "proxy": "basic",

    "formats": ["markdown"],
    "onlyMainContent": true,
    "excludeTags": [
      "img",
      "script",
      "style",
      "noscript",
      "iframe",
      "embed",
      "object",
      "video",
      "audio",
      "canvas",
      "svg",
      "picture",
      "source",
      "track",
      "map",
      "area",
      "link",
      "meta",
      "head",
      "footer",
      "nav",
      "aside",
      "header"
    ]
  }
}' 