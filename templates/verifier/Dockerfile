FROM node:24-bookworm-slim
RUN node -e "require('fs').writeFileSync('/tmp/minipass-ca.crt',require('tls').rootCertificates.join('\n'))" \
    && sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::CaInfo=/tmp/minipass-ca.crt -o Acquire::https::Timeout=30 -o Acquire::Retries=1 update \
    && apt-get -o Acquire::https::CaInfo=/tmp/minipass-ca.crt -o Acquire::https::Timeout=30 -o Acquire::Retries=1 install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/* /tmp/minipass-ca.crt
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY runner.js ./
USER node
CMD ["node", "runner.js"]
