FROM node:22-alpine
WORKDIR /app
# Zero dependencies on purpose: Socket Mode uses Node 22's built-in
# WebSocket, HTTP calls use built-in fetch.
COPY package.json ./
COPY bridge-core.mjs index.mjs ./
USER node
ENV NODE_ENV=production
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8096/healthz >/dev/null || exit 1
CMD ["node", "index.mjs"]
