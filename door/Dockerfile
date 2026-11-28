# Test gateway image. Same shape as hands-mcp/Dockerfile on this box.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /srv/helmian-door
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
USER node
EXPOSE 8098
CMD ["node", "src/index.mjs"]
