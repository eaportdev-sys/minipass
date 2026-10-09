# minipass template
# build stage + serve (vite emits dist/, CRA emits build/ - normalized to dist/)
FROM node:22-alpine AS build
# Build tools stay in this stage; the serving image remains nginx-only.
RUN apk add --no-cache python3 build-base autoconf automake libtool nasm pkgconf
WORKDIR /app
COPY . .
# Copy source before install because repository lifecycle scripts may need
# Prisma schemas, generator configs, workspace files, or other project assets.
RUN npm install
RUN npm run build && (test -d dist || (test -d build && mv build dist) || (echo "BUILD PRODUCED NO dist/ or build/ - add a build script emitting one of them or pick another type" && exit 1))
FROM nginx:alpine
# vite default (+ SPA fallback so deep links like /signup/warehouse load directly):
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
