FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app
COPY demo/aiops/kubernetes/remediation-connector/package.json demo/aiops/kubernetes/remediation-connector/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY demo/aiops/kubernetes/remediation-connector/server.mjs ./server.mjs

ENV NODE_ENV=production PORT=8085
USER 1000:1000
EXPOSE 8085
CMD ["node", "server.mjs"]
