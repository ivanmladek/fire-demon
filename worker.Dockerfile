# Use Python slim image as base
FROM python:3.11-slim

# Install Node.js and npm
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Google Cloud Storage Python package
RUN pip3 install google-cloud-storage

# Install Google Cloud SDK
RUN curl -sSL https://sdk.cloud.google.com | bash -s -- --disable-prompts \
    && ln -s /root/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud \
    && ln -s /root/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil

# Create directories for GCP credentials and backups
RUN mkdir -p /var/secrets/google && \
    mkdir -p /app/data/crawl_backups

# Set working directory
WORKDIR /app

# The command will be specified in docker-compose.yaml 