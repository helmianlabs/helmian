FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund
COPY bridge-core.mjs index.mjs mcp-core.mjs mcp-server.mjs ./
USER node
ENV STATE_DIR=/data NODE_ENV=production
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8095/healthz >/dev/null || exit 1
CMD ["node", "index.mjs"]
