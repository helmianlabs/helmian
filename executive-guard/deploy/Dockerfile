# Executive Guard verification server, self-host image.
#
# The server is pure Node with no dependencies (src/ and bin/ import
# only node: builtins and relative paths), so the image is just the
# runtime plus the three source trees the entry point needs, laid out
# repo-relative: src/action.mjs imports the redactor by its
# ../../extension/background/redact.js path.
FROM node:22-alpine

WORKDIR /app

COPY executive-guard/bin ./executive-guard/bin
COPY executive-guard/src ./executive-guard/src
COPY extension/background/redact.js ./extension/background/redact.js

# The signing key and the audit log live on separate volumes, so a
# leaked audit mount never carries the key and vice versa. The state
# file (pending approvals, used nonces) rides the audit volume, next
# to the audit log it belongs with.
ENV EXEC_GUARD_HOST=0.0.0.0 \
    EXEC_GUARD_PORT=8787 \
    EXEC_GUARD_KEY_PATH=/var/lib/executive-guard/keys/signing-key.pem \
    EXEC_GUARD_AUDIT_PATH=/var/lib/executive-guard/audit/audit.jsonl

RUN mkdir -p /var/lib/executive-guard/keys /var/lib/executive-guard/audit \
  && chown -R node:node /var/lib/executive-guard

VOLUME ["/var/lib/executive-guard/keys", "/var/lib/executive-guard/audit"]

USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "executive-guard/bin/executive-guard.mjs"]
