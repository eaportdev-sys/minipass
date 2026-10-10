# minipass template
# Universal Node.js template: works for Express, Fastify, NestJS, plain Node, etc.
# Build tools + git + build-time generator placeholders included.
FROM node:22-alpine

# Native npm modules can fall back to compiling when no Alpine binary exists.
# git is required for Husky, Lefthook, and private registry auth during install.
RUN apk add --no-cache python3 build-base autoconf automake libtool nasm pkgconf git

WORKDIR /app

# Build-time environment for generator scripts (prisma generate, drizzle-kit, etc.).
# These are ARG defaults only; the running container uses the site's real env.
ARG DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder
ARG SHADOW_DATABASE_URL=postgresql://build:build@localhost:5432/build_placeholder_shadow
ARG DIRECT_URL

# Copy package manifests first for optimal layer caching.
COPY package*.json ./

# Install dependencies. npm ci is faster and reproducible when lockfile exists.
RUN if [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then npm ci; else npm install; fi

# Copy source after install so lifecycle scripts (prepare, postinstall) have schemas/configs.
COPY . .

# Run build script if defined (tsc, nest build, etc.). Harmless if absent.
RUN npm run build --if-present

EXPOSE 3000

# Prefer the project's declared start command; retain the zero-config index.js fallback.
CMD ["sh", "-c", "if node -e \"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\"; then exec npm start; else exec node index.js; fi"]