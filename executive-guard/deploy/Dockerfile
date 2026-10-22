# Executive Guard. Build from the REPOSITORY ROOT (the server imports the
# extension's redact.js):
#   docker build -f executive-guard/deploy/Dockerfile -t executive-guard:local .
# No npm dependencies: Node built-ins only.
FROM node:20-alpine

ENV NODE_ENV=production \
    EXEC_GUARD_HOST=0.0.0.0 \
    EXEC_GUARD_PORT=8787 \
    EXEC_GUARD_DATA_DIR=/var/lib/executive-guard \
    EXEC_GUARD_KEY_PATH=/var/lib/executive-guard/keys/signing-key.pem \
    EXEC_GUARD_AUDIT_PATH=/var/lib/executive-guard/audit/audit.jsonl

WORKDIR /app
COPY --chown=root:root executive-guard/bin ./executive-guard/bin
COPY --chown=root:root executive-guard/src ./executive-guard/src
COPY --chown=root:root extension/background/redact.js ./extension/background/redact.js

# The code is root-owned and read-only to the service user. Only the two volume
# directories are writable, and only by that user.
RUN addgroup -S -g 10001 guard && adduser -S -D -H -u 10001 -G guard guard \
 && mkdir -p /var/lib/executive-guard/keys /var/lib/executive-guard/audit \
 && chown -R guard:guard /var/lib/executive-guard \
 && chmod 700 /var/lib/executive-guard/keys /var/lib/executive-guard/audit

USER guard:guard
VOLUME ["/var/lib/executive-guard/keys", "/var/lib/executive-guard/audit"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.EXEC_GUARD_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "executive-guard/bin/executive-guard.mjs"]
