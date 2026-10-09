FROM node:20-alpine
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
# docker CLI (to manage app containers via mounted sock) + git (for self-upgrade).
# util-linux-misc provides `script`, used as the PTY relay for browser terminals.
RUN apk add --no-cache git unzip openssh-client util-linux-misc docker-cli docker-compose 2>/dev/null || apk add --no-cache git unzip openssh-client util-linux-misc docker docker-compose 2>/dev/null || apk add --no-cache git unzip openssh-client util-linux-misc docker 2>/dev/null || true
# The /repo bind-mount is owned by the host user (uid 1000), but the panel runs
# as root: without this, every git command in /repo fails with "dubious
# ownership" and self-upgrade reports "repository not mounted".
RUN git config --global --add safe.directory /repo
WORKDIR /srv/panel
COPY backend/package.json ./
RUN npm i --omit=dev
COPY backend/. ./
COPY frontend/ ./frontend/
COPY templates/ ./templates/
EXPOSE 3001
CMD ["node", "server.js"]
