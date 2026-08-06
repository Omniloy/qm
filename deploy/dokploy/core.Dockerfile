# Core image for the Dokploy (single-host Docker) target.
#
# Identical to deploy/core/Dockerfile except for two deployment-target facts:
#   - SANDBOX_BACKEND=local drives agent computers through the host Docker
#     daemon, so the image needs the docker CLI on PATH.
#   - it therefore runs as root to reach the mounted /var/run/docker.sock,
#     instead of the unprivileged `node` user the Fly/AWS images use.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

RUN apk add --no-cache ca-certificates curl git git-daemon docker-cli

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm audit --omit=dev --audit-level=moderate \
  && rm -rf /root/.npm /tmp/node-compile-cache

COPY src ./src
COPY cli/templates/slack-manifest.json ./cli/templates/slack-manifest.json
COPY skills-seed ./skills-seed
COPY plugins/onboarding ./plugins/onboarding
COPY plugins/chassis ./plugins/chassis
COPY tsconfig.json ./

ENV NODE_ENV=production
ENV DATA_DIR=/data
ARG GIT_SHA=
ENV GIT_SHA=$GIT_SHA
RUN mkdir -p /data
EXPOSE 8080

CMD ["node", "src/index.ts"]
