# minipass template
# build stage + serve (vite outputs dist/, CRA outputs build/ - adjust COPY below)
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm i || true
COPY . .
RUN npm run build && test -d dist || (echo "BUILD PRODUCED NO dist/ - add a build script emitting dist/ or pick another type" && exit 1)
FROM nginx:alpine
# vite default (+ SPA fallback so deep links like /signup/warehouse load directly):
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
