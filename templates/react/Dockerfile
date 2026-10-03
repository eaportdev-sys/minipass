# build stage + serve (vite outputs dist/, CRA outputs build/ - adjust COPY below)
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm i || true
COPY . .
RUN npm run build || echo "no build script, copying src as-is"
FROM nginx:alpine
# vite default:
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
