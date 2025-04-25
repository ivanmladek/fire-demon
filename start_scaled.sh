#!/bin/bash

# This script starts the Docker Compose services in detached mode
# with specific scaling for the worker and playwright services.

# --- Configuration ---
WORKER_SCALE=10
PLAYWRIGHT_SCALE=20
# -------------------

echo "Starting Firecrawl services with scaling:"
echo "  Workers: $WORKER_SCALE"
echo "  Scrapers: $PLAYWRIGHT_SCALE"

docker compose up -d --scale worker=$WORKER_SCALE --scale playwright-service=$PLAYWRIGHT_SCALE

echo "Services started in detached mode." 