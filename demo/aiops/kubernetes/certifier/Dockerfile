FROM registry.k8s.io/kubectl:v1.34.8@sha256:186cd2d31d25fb766566eb5049f7993bd3a81f265b1e99a1fd6199c4c69e26dc AS kubectl

FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

WORKDIR /app
COPY --from=kubectl /bin/kubectl /usr/local/bin/kubectl
COPY scripts/certify-kubernetes-connector.mjs ./scripts/certify-kubernetes-connector.mjs
COPY scripts/renew-kubernetes-certification.mjs ./scripts/renew-kubernetes-certification.mjs

USER node
ENTRYPOINT ["node", "/app/scripts/renew-kubernetes-certification.mjs"]
