FROM node:20-alpine
WORKDIR /srv/panel
COPY backend/package.json ./
RUN npm i --omit=dev
COPY backend/. ./
COPY frontend/ ./frontend/
COPY templates/ ./templates/
EXPOSE 3001
CMD ["node", "server.js"]
