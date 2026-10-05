FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build --if-present
EXPOSE 3000
# Prefer the project's declared start command; retain the zero-config index.js fallback.
CMD ["sh", "-c", "if node -e \"const p=require('./package.json');process.exit(p.scripts&&p.scripts.start?0:1)\"; then exec npm start; else exec node index.js; fi"]
