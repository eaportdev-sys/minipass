FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm i --omit=dev || true
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
