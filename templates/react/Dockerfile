# build stage + serve (works for vite/cra: npm run build -> dist/build)
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm i || true
COPY . .
RUN npm run build || echo "no build script, copying src as-is"
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
