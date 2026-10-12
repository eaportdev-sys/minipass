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
ENV PACKAGE_MANAGER=${PACKAGE_MANAGER}

# Copy source before install. Many real apps run generate/prepare hooks during
# install that need schemas/config files, so correctness wins over a package-only
# cache layer.
COPY . .

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
      pnpm install --dangerously-allow-all-builds --frozen-lockfile --prefer-offline || pnpm install --frozen-lockfile --prefer-offline || pnpm install --dangerously-allow-all-builds --prefer-offline --no-frozen-lockfile || pnpm install --prefer-offline --no-frozen-lockfile; \
    elif [ "$PACKAGE_MANAGER" = "yarn" ]; then \
      corepack enable >/dev/null 2>&1; \
      yarn install --frozen-lockfile || yarn install; \
    elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then \
      npm ci --prefer-offline; \
    else \
      npm install --prefer-offline; \
    fi

# Run build script if defined (tsc, nest build, etc.). Harmless if absent.
RUN if [ "$PACKAGE_MANAGER" = "pnpm" ]; then pnpm run build --if-present; \
    elif [ "$PACKAGE_MANAGER" = "yarn" ]; then if node -e "const s=require('./package.json').scripts||{};process.exit(s.build?0:1)"; then yarn run build; fi; \
    else npm run build --if-present; fi

# Runtime stage — smaller, no build tools
FROM minipass/node:22-runtime
ARG PACKAGE_MANAGER=npm
ENV PACKAGE_MANAGER=${PACKAGE_MANAGER}

WORKDIR /app

# Copy built application from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist 2>/dev/null || true
COPY --from=build /app/build ./build 2>/dev/null || true
COPY --from=build /app ./

EXPOSE 3000

# Prefer a production script, avoid common dev-server `start` scripts, then fall
# back to framework CLIs or index.js. Run scripts with the same manager used to
# install so pnpm/yarn workspaces keep their runtime layout.
CMD ["sh", "-c", "pm=npm; if [ \"$PACKAGE_MANAGER\" = \"pnpm\" ]; then corepack enable >/dev/null 2>&1; pm=pnpm; elif [ \"$PACKAGE_MANAGER\" = \"yarn\" ]; then corepack enable >/dev/null 2>&1; pm=yarn; fi; script=$(node -e \"const p=require('./package.json');const s=p.scripts||{};const dev=/^(next dev|nuxt dev|vite($| )|react-scripts start|ng serve|vue-cli-service serve)/;for (const k of ['start:prod','start:production','start:built','serve']) if(s[k]){console.log(k);process.exit(0)} if(s.start&&!dev.test(s.start)){console.log('start');process.exit(0)} process.exit(1)\" 2>/dev/null || true); if [ -n \"$script\" ]; then exec $pm run $script; elif node -e \"const p=require('./package.json');process.exit((p.dependencies&&p.dependencies.next)||(p.devDependencies&&p.devDependencies.next)?0:1)\"; then exec $pm exec next start -H 0.0.0.0 -p ${PORT:-3000}; elif [ -f index.js ]; then exec node index.js; else echo 'No production start script found (start was a dev server). Add start:prod/start:built/serve or index.js.'; exit 1; fi"]
