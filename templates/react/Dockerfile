# minipass template
# Universal React/Vite/CRA/Next (static export) template.
# Build stage includes BuildKit cache mount + git + generator placeholders.
# Serve stage is pure nginx - no Node in production image.
# syntax = docker/dockerfile:1.4
FROM minipass/node:22 AS build

# Build-time environment for generator scripts (prisma generate, etc.).
# These are ARG defaults only; the running container uses the site's real env.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder
ARG SHADOW_DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder_shadow
ARG DIRECT_URL

# Copy package manifests first for optimal layer caching.
COPY package*.json ./

# Install dependencies with SHARED npm cache mount (persistent across all sites/builds).
# --prefer-offline uses cache when available, falls back to network.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \
      npm ci --prefer-offline; \
    else \
      npm install --prefer-offline; \
    fi

# Copy source after install so lifecycle scripts have schemas/configs.
COPY . .

# Build the production bundle. Vite emits dist/, CRA emits build/.
# Normalize to dist/ for the nginx stage.
RUN npm run build && (test -d dist || (test -d build && mv build dist) || (echo "BUILD PRODUCED NO dist/ or build/ - add a build script emitting one of them or pick another type" && exit 1))

# Serve stage: pure nginx, no Node.js
FROM nginx:alpine

# SPA fallback so deep links like /signup/warehouse load directly.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80