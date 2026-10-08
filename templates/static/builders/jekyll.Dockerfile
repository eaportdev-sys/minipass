# minipass static builder: jekyll
FROM node:24-bookworm-slim AS node
FROM ruby:3.3-bookworm AS build
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential autoconf automake libtool nasm pkg-config && rm -rf /var/lib/apt/lists/*
RUN gem install bundler -v 2.6.9 --no-document
ENV BUNDLE_VERSION=system
WORKDIR /app
COPY . .
ARG MINIPASS_MODERNIZE=0
ARG MINIPASS_STATIC_OUTPUT=_site
# Explicit build-only adaptation: repository files outside this stage stay intact.
RUN if [ "$MINIPASS_MODERNIZE" = "1" ] && [ -f package.json ]; then node -e "const fs=require('fs'),p=require('./package.json');for(const key of ['dependencies','devDependencies']){const d=p[key]||{};if(d['node-sass']){delete d['node-sass'];if(!d.sass)d.sass='^1.93.2';}const w=/^[~^]?5\.(\d+)\./.exec(d.webpack||'');if(w&&Number(w[1])<61){d.webpack='^5.99.9';}}fs.writeFileSync('package.json',JSON.stringify(p,null,2));"; fi
RUN if [ -f package.json ]; then npm install; fi
RUN if [ "$MINIPASS_MODERNIZE" = "1" ]; then bundle update --all --bundler=2.6.9; else bundle install; fi
RUN if [ -f package.json ] && node -e "process.exit(require('./package.json').scripts?.build?0:1)"; then npm run build; else bundle exec jekyll build; fi
RUN test -f "$MINIPASS_STATIC_OUTPUT/index.html" || (echo "Jekyll build did not produce an index.html in the configured output folder" && exit 1)
RUN mkdir /site-output && cp -a "./$MINIPASS_STATIC_OUTPUT/." /site-output/
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site-output /usr/share/nginx/html
EXPOSE 80
