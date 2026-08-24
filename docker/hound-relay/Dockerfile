FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43

ENV NODE_ENV=production \
    HOUND_UPSTREAM_HOST=hound-firewall \
    HOUND_UPSTREAM_PORT=8765 \
    HOUND_RELAY_HOST=0.0.0.0 \
    HOUND_RELAY_PORT=8765

WORKDIR /app
COPY --chown=node:node relay.mjs server.mjs ./

USER node
EXPOSE 8765

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8765/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "/app/server.mjs"]
