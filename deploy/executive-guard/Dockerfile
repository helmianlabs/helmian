# Executive Guard (executive-guard/, PR #53) for the Hetzner box. No npm deps.
# Build context: a git archive of the Guard branch (needs executive-guard/ and
# extension/background/redact.js, which action.mjs imports for the unredacted-content check).
FROM node:22-slim
ENV NODE_ENV=production EXEC_GUARD_HOST=0.0.0.0 EXEC_GUARD_PORT=8787 EXEC_GUARD_DATA_DIR=/data
WORKDIR /srv
COPY executive-guard ./executive-guard
COPY extension/background/redact.js ./extension/background/redact.js
COPY package.json ./package.json
USER node
EXPOSE 8787
CMD ["node", "executive-guard/bin/executive-guard.mjs"]
