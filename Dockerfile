FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Build Visual Workflow Builder (Vite + React)
FROM node:20-alpine AS workflow-builder-builder

WORKDIR /app/workflow-builder
COPY workflow-builder/package.json workflow-builder/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY workflow-builder/ ./
RUN npm run build

# Install Console dependencies once. The chat build consumes the shared workspace
# sidebar source from this stage so both SPAs use the same navigation component.
FROM node:20-alpine AS console-ui-deps

WORKDIR /app/argus-console
COPY argus-console/package.json argus-console/package-lock.json ./
RUN npm ci

# Build Chat SPA (Vite + React)
FROM console-ui-deps AS chat-ui-builder

WORKDIR /app
RUN mkdir -p /app/argus-console/src/components
COPY argus-console/src/components/WorkspaceSidebar.tsx /app/argus-console/src/components/WorkspaceSidebar.tsx
COPY argus-console/src/components/workspaceSidebar.css /app/argus-console/src/components/workspaceSidebar.css
COPY argus-console/src/types.ts /app/argus-console/src/types.ts
WORKDIR /app/argus-chat-ui
COPY argus-chat-ui/package.json argus-chat-ui/package-lock.json ./
RUN npm ci
COPY argus-chat-ui/ ./
RUN npm run build

# Build the primary Argus Console (Vite + React)
FROM console-ui-deps AS console-ui-builder

WORKDIR /app/argus-console
COPY argus-console/ ./
RUN npm run build

FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ ./dist/
COPY --from=workflow-builder-builder /app/dist/builder/ ./dist/builder/
COPY --from=chat-ui-builder /app/argus-chat-ui/dist/ ./argus-chat-ui/dist/
COPY --from=console-ui-builder /app/argus-console/dist/ ./argus-console/dist/
COPY src/assets/ ./assets/
COPY db/migrations/ ./db/migrations/

# The non-root audit retry queue must be writable. Mount this directory on a
# persistent volume where retry evidence must survive container replacement.
RUN mkdir -p /app/data && chown node:node /app/data && chmod 0700 /app/data
USER node
EXPOSE 3000

# Cap the V8 heap so K8s memory limits don't OOM-kill the pod before Node GCs.
# 1536 MB leaves ~512 MB headroom for native allocations under a 2 GB pod limit.
ENV NODE_OPTIONS="--max-old-space-size=1536"

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "--import", "./dist/instrumentation.js", "dist/index.js"]
