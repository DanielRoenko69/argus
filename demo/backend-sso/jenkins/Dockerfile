FROM jenkins/jenkins:lts-jdk21@sha256:c1e4c349365f6d16d88595b2c5f7e8ff39b8ae1d061f62420bac193b4b9616d0

# Versions are deliberately pinned. The base image digest is multi-arch so the
# same demo works on Docker Desktop/Windows and Apple Silicon Macs.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl docker-cli git nodejs npm \
    && rm -rf /var/lib/apt/lists/*
# The FastAPI template uses RUN --mount, which the legacy Docker builder
# cannot parse. Keep Buildx multi-arch and digest-pinned for Windows/Mac hosts.
COPY --from=docker/buildx-bin:0.37.1@sha256:0ef4e936b9057e45a8c6595c01a8116353acd102b6a5720af7c3bcb50346e2ca \
    /buildx /usr/libexec/docker/cli-plugins/docker-buildx
RUN docker buildx version
USER jenkins

RUN jenkins-plugin-cli --latest=false --plugins \
    configuration-as-code:2036.v0b_c2de701dcb_ \
    matrix-auth:3.3 \
    oic-auth:4.718.ve731df6ca_88a_ \
    workflow-job:1602.v2a_70b_80a_2396 \
    workflow-cps:4383.v04fa_a_3d67b_d9 \
    workflow-durable-task-step:1479.v56e587f413a_7 \
    workflow-basic-steps:1098.v808b_fd7f8cf4 \
    workflow-scm-step:487.v41313a_96b_65d \
    pipeline-stage-step:345.va_96187909426 \
    git:5.10.1 \
    git-client:6.6.1 \
    credentials-binding:728.v902a_273b_8947

COPY jenkins.yaml /usr/share/jenkins/ref/jenkins.yaml
COPY init.groovy.d/ /usr/share/jenkins/ref/init.groovy.d/
