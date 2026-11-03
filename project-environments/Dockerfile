# Match the workspace's Python and libc, not the operator's macOS interpreter.
FROM node:20-alpine AS resolver
RUN apk add --no-cache python3 py3-pip ca-certificates \
 && pip install --break-system-packages --no-deps --only-binary=:all: pip==25.2 packaging==25.0 \
 && mkdir /cache && chown 1000:1000 /cache
WORKDIR /service
COPY policy.py server.py download.py ./
USER 1000:1000
CMD ["python3", "-B", "/service/server.py"]

FROM node:20-alpine AS egress
RUN apk add --no-cache python3
WORKDIR /service
COPY egress.py ./
USER 1000:1000
CMD ["python3", "-B", "/service/egress.py"]
