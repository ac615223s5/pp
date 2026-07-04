# Single-stage build. Node 22 ships a global WebCrypto (crypto.subtle) which
# @cloudflare/privacypass-ts uses for Blind RSA. build-essential/python are only
# needed so better-sqlite3 can compile if no prebuilt binary matches the platform.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
COPY client ./client
COPY public ./public

# tsc -> dist/ (server + admin), esbuild -> public/activate.js (browser bundle)
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "dist/server.js"]
