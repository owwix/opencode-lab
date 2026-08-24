FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

ENV NODE_ENV=production \
    PREVIEW_LISTEN_HOST=0.0.0.0 \
    PREVIEW_UPSTREAM_HOST=opencode-app

WORKDIR /app
COPY --chown=node:node server.mjs ./

USER node
EXPOSE 3000 3001

CMD ["node", "/app/server.mjs"]
