FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

WORKDIR /app/docker/notion-publisher
COPY --chown=node:node docker/notion-publisher/server.mjs ./
COPY --chown=node:node docker/agent-gateway/capability-lease.mjs /app/docker/agent-gateway/
USER node
CMD ["node", "server.mjs"]
