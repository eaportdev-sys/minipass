FROM node:20-alpine
ARG GIT_SHA=dev
ENV GIT_SHA=${GIT_SHA}
# docker CLI (to manage app containers via mounted sock) + git (for self-upgrade)
RUN apk add --no-cache git docker-cli docker-compose 2>/dev/null || apk add --no-cache git docker docker-compose 2>/dev/null || apk add --no-cache git docker 2>/dev/null || true
WORKDIR /srv/panel
COPY backend/package.json ./
RUN npm i --omit=dev
COPY backend/. ./
COPY frontend/ ./frontend/
COPY templates/ ./templates/
EXPOSE 3001
CMD ["node", "server.js"]
