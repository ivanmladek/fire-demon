FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable
COPY . /app
WORKDIR /app

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install && pnpm run build

# Install Go
FROM golang:1.24 AS go-base
COPY sharedLibs/go-html-to-md /app/sharedLibs/go-html-to-md

# Install Go dependencies and build parser lib
RUN cd /app/sharedLibs/go-html-to-md && \
    go mod tidy && \
    go build -o html-to-markdown.so -buildmode=c-shared html-to-markdown.go && \
    chmod +x html-to-markdown.so

# Install Rust
FROM rust:1-slim AS rust-base
COPY sharedLibs/html-transformer /app/sharedLibs/html-transformer

# Install Rust dependencies and build transformer lib
RUN cd /app/sharedLibs/html-transformer && \
    cargo build --release && \
    chmod +x target/release/libhtml_transformer.so

FROM base
COPY --from=build /app/dist /app/dist
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=go-base /app/sharedLibs/go-html-to-md/html-to-markdown.so /app/sharedLibs/go-html-to-md/html-to-markdown.so
COPY --from=rust-base /app/sharedLibs/html-transformer/target/release/libhtml_transformer.so /app/sharedLibs/html-transformer/target/release/libhtml_transformer.so

# Install git and GCP SDK
RUN apt-get update && \
    apt-get install -y git apt-transport-https ca-certificates gnupg curl python3 python3-pip && \
    echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list && \
    curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | apt-key --keyring /usr/share/keyrings/cloud.google.gpg add - && \
    apt-get update && \
    apt-get install -y google-cloud-sdk && \
    rm -rf /var/lib/apt/lists/*

# Start the server by default, this can be overwritten at runtime
EXPOSE 8080

# Make sure the entrypoint script has the correct line endings
RUN sed -i 's/\r$//' /app/docker-entrypoint.sh

ENTRYPOINT "/app/docker-entrypoint.sh"
