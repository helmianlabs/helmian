# Build from the REPO ROOT so the shared routing policy comes along:
#   docker build -f hands-mcp/Dockerfile -t helmian-hands-mcp .
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /srv/hands-mcp
COPY hands-mcp/package.json hands-mcp/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY hands-mcp/src ./src
COPY src/core/compute-routing.mjs /srv/src/core/compute-routing.mjs
USER node
EXPOSE 8090
CMD ["node", "src/index.mjs"]
