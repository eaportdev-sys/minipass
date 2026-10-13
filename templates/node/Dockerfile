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

# A Next.js production server needs the build output. Fail here with the
# reason instead of shipping an image that crash-loops on `next start`
# (e.g. repos whose build script targets a worker bundle, never .next/).
# A bare `.next/` directory is not proof: only BUILD_ID means `next build`
# ran. Framework builds that emit a standalone server instead
# (dist/standalone/server.js) are runnable output too - the container boots
# that directly (see CMD below).
RUN if node -e "const p=require('./package.json');const d={...(p.dependencies||{}),...(p.devDependencies||{})};process.exit(d.next?0:1)"; then \
      if [ -f .next/BUILD_ID ]; then \
        echo "Next.js production build present."; \
      elif [ -f dist/standalone/server.js ]; then \
        echo "No .next production build, but dist/standalone/server.js exists - the container will run the built standalone server."; \
      else \
        echo "BUILD PRODUCED NO .next/BUILD_ID and no dist/standalone/server.js BUT next IS A DEPENDENCY. The repo build did not run 'next build' (this repo may target a different runtime, e.g. a worker bundle). Add a repo Dockerfile that serves the real output, or a start:prod script for it - 'next start' can never work without a production build."; \
        exit 1; \
      fi; \
    fi

# Runtime stage — smaller, no build tools
FROM minipass/node:22-runtime
ARG PACKAGE_MANAGER=npm
ENV PACKAGE_MANAGER=${PACKAGE_MANAGER}

WORKDIR /app

# Copy built application from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package*.json ./
COPY --from=build /app ./

EXPOSE 3000

# Prefer a production script, avoid common dev-server `start` scripts, then fall
# back to framework CLIs or index.js. Run scripts with the same manager used to
# install so pnpm/yarn workspaces keep their runtime layout.
# A 127.0.0.1 bind is unreachable through Docker port publishing (the socket
# only accepts loopback inside the container's own network namespace), so known
# server bind flags are normalized to 0.0.0.0 - same class of environment
# adaptation as PORT injection. Anything else runs untouched.
# Framework builds that emit a standalone server (dist/standalone/server.js)
# without a .next production build boot that directly: `next start` can never
# work without .next/BUILD_ID, and the standalone server honors PORT while
# HOSTNAME is pinned to 0.0.0.0 so the published port can reach it.
CMD ["sh", "-c", "if [ ! -f .next/BUILD_ID ] && [ -f dist/standalone/server.js ]; then echo \"panel: no .next production build - running built standalone server dist/standalone/server.js\"; export HOSTNAME=0.0.0.0; exec node dist/standalone/server.js; fi; pm=npm; if [ \"$PACKAGE_MANAGER\" = \"pnpm\" ]; then corepack enable >/dev/null 2>&1; pm=pnpm; elif [ \"$PACKAGE_MANAGER\" = \"yarn\" ]; then corepack enable >/dev/null 2>&1; pm=yarn; fi; script=$(node -e \"const p=require('./package.json');const s=p.scripts||{};const dev=/^(next dev|nuxt dev|vite($| )|react-scripts start|ng serve|vue-cli-service serve)/;for (const k of ['start:prod','start:production','start:built','serve']) if(s[k]){console.log(k);process.exit(0)} if(s.start&&!dev.test(s.start)){console.log('start');process.exit(0)} process.exit(1)\" 2>/dev/null || true); if [ -n \"$script\" ]; then body=$(node -e \"console.log((require('./package.json').scripts||{})['$script']||'')\" 2>/dev/null || true); case \"$body\" in *-H\\ 127.0.0.1*|*-H127.0.0.1*|*--hostname*127.0.0.1*|*--host*127.0.0.1*) echo \"panel: start script binds 127.0.0.1, rebinding to 0.0.0.0 so the published port can reach it\"; body=$(printf '%s' \"$body\" | sed -e 's/-H  *127\\.0\\.0\\.1/-H 0.0.0.0/g' -e 's/-H127\\.0\\.0\\.1/-H0.0.0.0/g' -e 's/--hostname[= ]127\\.0\\.0\\.1/--hostname 0.0.0.0/g' -e 's/--host[= ]127\\.0\\.0\\.1/--host 0.0.0.0/g'); exec sh -c \"export PATH=\\\"$PWD/node_modules/.bin:$PATH\\\"; $body\";; *) exec $pm run $script;; esac; elif node -e \"const p=require('./package.json');process.exit((p.dependencies&&p.dependencies.next)||(p.devDependencies&&p.devDependencies.next)?0:1)\"; then exec $pm exec next start -H 0.0.0.0 -p ${PORT:-3000}; elif [ -f index.js ]; then exec node index.js; else echo 'No production start script found (start was a dev server). Add start:prod/start:built/serve or index.js.'; exit 1; fi"]
