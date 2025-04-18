#!/bin/bash

# Check if job ID is provided
if [ -z "$1" ]; then
    echo "Error: Please provide a job ID"
    echo "Usage: $0 <job_id>"
    exit 1
fi

# Store the job ID
JOB_ID="$1"

# Make the curl request and process with jq
curl -X GET "http://localhost:3002/v0/crawl/status/${JOB_ID}" | jq -r '.data[] | [.metadata.url, .metadata.pageStatusCode] | @csv' 