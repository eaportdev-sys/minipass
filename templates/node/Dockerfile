# minipass template
# Universal Node.js template — uses pre-built base image with shared cache
# syntax = docker/dockerfile:1.4
FROM minipass/node:22 AS build

# Build-time environment for generator scripts (prisma generate, drizzle-kit, etc.).
# These are ARG defaults only; the running container uses the site's real env.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder
ARG SHADOW_DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder_shadow
ARG DIRECT_URL
# Package manager chosen at build time (deploy passes PACKAGE_MANAGER from the
# detected packageManager field or lockfiles; default npm preserves old builds).
ARG PACKAGE_MANAGER=npm

# Copy package manifests first for optimal layer caching.
COPY package*.json ./

# Install dependencies with shared cache mounts (persistent across all sites/builds).
# --prefer-offline uses cache when available, falls back to network.
# pnpm/yarn come from corepack (bundled with Node); a stale frozen lockfile
# falls back to a resolving install so only truly broken installs fail.
# bun has no binary in this image and degrades to npm.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    --mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked \
    export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; \
    if [ "$PACKAGE_MANAGER" = "pnpm" ]; then \
      corepack enable >/dev/null 2>&1; \
      pnpm install --frozen-lockfile --prefer-offline || pnpm install --prefer-offline --no-frozen-lockfile; \
    elif [ "$PACKAGE_MANAGER" = "yarn" ]; then \
      corepack enable >/dev/null 2>&1; \
      yarn install --frozen-lockfile || yarn install; \
    elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \
      npm ci --prefer-offline; \
    else \
      npm install --prefer-offline; \
    fi

# Copy source after install so lifecycle scripts (prepare, postinstall) have schemas/configs.
COPY . .

# Run build script if defined (tsc, nest build, etc.). Harmless if absent.
RUN npm run build --if-present

# Runtime stage — smaller, no build tools
FROM minipass/node:22-runtime

WORKDIR /app

# Copy built application from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist 2>/dev/null || true
COPY --from=build /app/build ./build 2>/dev/null || true
COPY --from=build /app ./

EXPOSE 3000

# Prefer the project's declared start command; retain the zero-config index.js fallback.
CMD ["sh", "-c", "if node -e \"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\"; then exec npm start; else exec node index.js; fi"]