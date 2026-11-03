FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY upstream/ ./upstream/
RUN npm run verify

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=builder --chown=node:node /app/dist ./dist
RUN mkdir -p /var/lib/argus-hermes && chown -R node:node /var/lib/argus-hermes
USER node
EXPOSE 2040
CMD ["node", "dist/server.js"]

# The Pack image above remains unprivileged and has no container-engine CLI.
# Only this explicitly selected target can act as the separately deployed
# runnerd broker. Operators still have to mount the Docker socket and the
# strict policy/attestation files in the managed Compose overlay.
FROM runtime AS runnerd
USER root
RUN apk add --no-cache docker-cli
USER node
EXPOSE 2042
CMD ["node", "dist/runnerdServer.js"]

# Keep the ordinary Pack as the default final target for existing builds.
FROM runtime AS pack
