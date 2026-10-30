FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY *.mjs ./
COPY connectors ./connectors
ENV NODE_ENV=production CORA_SANDBOX_PORT=8110 CORA_SANDBOX_HOST=0.0.0.0
EXPOSE 8110
USER node
CMD ["node", "server.mjs"]
