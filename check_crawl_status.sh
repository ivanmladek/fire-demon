#!/bin/bash

# Check if job ID is provided
if [ -z "$1" ]; then
    echo "Usage: $0 <job_id>"
    exit 1
fi

JOB_ID=$1

# Make the API call and format output as CSV
curl -X GET "http://localhost:3002/v0/crawl/status/$JOB_ID" | \
jq -r '.partial_data[] | select(.metadata != null) | [.metadata.url, .metadata.pageStatusCode] | @csv' 