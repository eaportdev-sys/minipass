# minipass template
FROM node:22-alpine
# Native npm modules can fall back to compiling when no Alpine binary exists.
RUN apk add --no-cache python3 build-base autoconf automake libtool nasm pkgconf
WORKDIR /app
COPY . .
# Copy source before install because repository lifecycle scripts may need
# Prisma schemas, generator configs, workspace files, or other project assets.
RUN npm install
RUN npm run build --if-present
EXPOSE 3000
# Prefer the project's declared start command; retain the zero-config index.js fallback.
CMD ["sh", "-c", "if node -e \"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\"; then exec npm start; else exec node index.js; fi"]
