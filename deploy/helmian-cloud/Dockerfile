FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY sql ./sql
COPY docs ./docs
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["/bin/sh", "-c", "exec node bin/helmion-cora.mjs --host 0.0.0.0 --port \"${PORT}\" --token \"${HELMION_CORA_TOKEN}\" --provider \"${HELMION_CORA_PROVIDER:-claude}\" --tier \"${HELMION_CORA_TIER:-standard}\" --permission \"${HELMION_CORA_PERMISSION:-ask}\" --quiet"]
