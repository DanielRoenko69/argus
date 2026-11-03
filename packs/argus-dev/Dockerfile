FROM node:20-alpine AS builder

# Shell-level preflight/checksum tests execute real Bash and GNU sha256sum,
# not a host tool (BusyBox lacks the required --check --strict options).
# Keep this build/test dependency out of the production runtime stage.
RUN apk add --no-cache bash coreutils

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/
COPY tsconfig.json ./
RUN npm test
RUN npm run build

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 2025

CMD ["node", "dist/server.js"]
