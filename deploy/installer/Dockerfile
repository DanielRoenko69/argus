FROM docker:29-cli

RUN apk add --no-cache docker-cli-compose nodejs openssl

WORKDIR /workspace/argus-core

ENTRYPOINT ["/bin/sh", "/workspace/argus-core/scripts/docker-install.sh"]
