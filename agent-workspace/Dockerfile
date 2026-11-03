FROM oven/bun:1.3.14-alpine AS bun-runtime

FROM node:20-alpine

ARG GRAPHIFY_VERSION=0.9.32
ARG ARGUS_DEV_MULTILANG=true

# Tooling the Dev Agent will use to do real work
# graphifyy depends on tree-sitter-dm which has a C-extension → needs gcc to build.
# Build-tools are installed as virtual package and removed after graphify install
# to keep the image lean.
COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

RUN apk add --no-cache git python3 py3-pip bash curl openssh-client sudo libgcc libstdc++ bubblewrap libseccomp \
 && apk add --no-cache --virtual .build-deps gcc python3-dev musl-dev \
 && git config --system user.name "Argus Dev Agent" \
 && git config --system user.email "argus-agent@argus.local" \
 # Allow the node user to run pip as root (needed for --break-system-packages)
 && echo "node ALL=(ALL) NOPASSWD: /usr/bin/pip3, /usr/bin/pip" >> /etc/sudoers.d/argus-pip \
 && chmod 0440 /etc/sudoers.d/argus-pip \
 # Install graphify CLI for codegraph tools (compiles tree-sitter-dm C-ext).
 # Keep the uv environment outside /root: the runtime image drops to the node
 # user, which cannot traverse /root even when /usr/local/bin contains a
 # symlink to the entrypoint.
 && pip install --break-system-packages uv \
 # Fixed offline installer tooling; never expose pip or arbitrary install commands to QA.
 && pip install --no-deps --only-binary=:all: --target /opt/argus-environment-tools installer==0.7.0 packaging==25.0 \
 && UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install "graphifyy==${GRAPHIFY_VERSION}" \
 && chmod -R a+rX /opt/uv-tools \
 # Strip build-only deps now that graphify-binaries exist
 && apk del .build-deps \
 && ln -sf /usr/local/bin/bun /usr/local/bin/bunx

# Argus.Dev uses deterministic project profiles rather than asking an LLM to
# invent build commands. The full toolchain set is isolated to this workspace
# image and is never built by the Core-only bootstrap. Set the build argument
# to false for a lightweight Node/Python-only workspace.
RUN if [ "$ARGUS_DEV_MULTILANG" = "true" ]; then \
      apk add --no-cache go rust cargo openjdk21-jdk maven gradle dotnet8-sdk; \
    fi \
 && corepack enable

# Build the sidecar server
WORKDIR /app
COPY package*.json ./
RUN npm ci \
 && npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.197
COPY tsconfig.json ./
COPY src ./src
COPY scripts/install-codex-sandbox-helper.mjs ./scripts/install-codex-sandbox-helper.mjs
RUN npx tsc \
 && npm prune --omit=dev \
 && node scripts/install-codex-sandbox-helper.mjs \
 && ln -sf /app/node_modules/.bin/codex /usr/local/bin/codex

# Persistent volume mount point — owned by node user
RUN mkdir -p /workspace /runtime/technical-experiments /home/node/.local /home/node/.codex /home/node/.claude && chown -R node:node /workspace /runtime /home/node /app
WORKDIR /workspace

# Drop to non-root: the node user (UID 1000) ships with node:alpine
USER node

# Build-time permission probe: catches root-owned/symlinked tool regressions.
RUN graphify --version

EXPOSE 3001

CMD ["node", "/app/dist/server.js"]
