# minipass base runtime — minimal Node.js runtime for production
# syntax = docker/dockerfile:1.4
FROM node:22-alpine

# Runtime dependencies for native modules
RUN apk add --no-cache \
    vips cairo pango giflib libjpeg-turbo libpng \
    sqlite-libs postgresql-libs \
    git

# npm cache directory for BuildKit mount
RUN mkdir -p /root/.npm && chmod 777 /root/.npm

WORKDIR /app