# minipass base image — build once, reuse for all Node.js deploys
# Pre-installs: build tools, git, common native module dependencies
# Pre-compiles: bcrypt, sharp, sqlite3, canvas, node-gyp modules
# syntax = docker/dockerfile:1.4
FROM node:22-alpine AS builder

# Install all build dependencies once
RUN apk add --no-cache \
    python3 build-base autoconf automake libtool nasm pkgconf git \
    vips-dev cairo-dev pango-dev giflib-dev libjpeg-turbo-dev libpng-dev \
    sqlite-dev postgresql-dev

# Pre-compile common native modules to avoid per-deploy compilation
# These are the most common native deps across Node.js projects
RUN npm install -g node-gyp && \
    npm pack bcrypt@5.1.1 --dry-run 2>/dev/null | head -1 && \
    mkdir -p /precompiled && \
    cd /precompiled && \
    npm pack bcrypt@5.1.1 sharp@0.33.5 sqlite3@5.1.7 canvas@2.11.2 better-sqlite3@9.6.0 2>/dev/null || true && \
    ls -la *.tgz 2>/dev/null | head -20

# Final base image — minimal, only runtime deps
FROM node:22-alpine

# Runtime dependencies for native modules
RUN apk add --no-cache \
    vips cairo pango giflib libjpeg-turbo libpng \
    sqlite-libs postgresql-libs \
    git

# Copy pre-compiled native modules (if any succeeded)
COPY --from=builder /precompiled/*.tgz /tmp/precompiled/ 2>/dev/null || true

# Install pre-compiled modules globally so they're available without recompilation
RUN if ls /tmp/precompiled/*.tgz 1>/dev/null 2>&1; then \
      npm install -g /tmp/precompiled/*.tgz && \
      rm -rf /tmp/precompiled; \
    fi

# npm cache directory for BuildKit mount
RUN mkdir -p /root/.npm && chmod 777 /root/.npm

WORKDIR /app