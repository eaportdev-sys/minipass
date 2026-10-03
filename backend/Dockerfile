FROM node:20-alpine
WORKDIR /srv/panel
COPY package.json ./
RUN npm i --omit=dev
COPY . .
EXPOSE 3001
CMD ["node", "server.js"]
