#!/usr/bin/env bash
# Run ON the Hetzner box as root from /opt/helmian-hands-mcp/src (a git archive of the repo).
# Builds the image, (re)starts the container on 127.0.0.1:8090 only, leaves claude-memory-mcp alone.
set -euo pipefail
cd /opt/helmian-hands-mcp/src
TAG="helmian-hands-mcp:$(date +%Y%m%d-%H%M%S)"
docker build -f hands-mcp/Dockerfile -t "$TAG" .
mkdir -p /opt/helmian-hands-mcp/data && chown 1000:1000 /opt/helmian-hands-mcp/data && chmod 700 /opt/helmian-hands-mcp/data
docker rm -f helmian-hands-mcp >/dev/null 2>&1 || true
docker run -d --name helmian-hands-mcp --restart unless-stopped \
  --env-file /opt/helmian-hands-mcp/app.env \
  -v /opt/helmian-hands-mcp/data:/data \
  -p 127.0.0.1:8090:8090 \
  --memory 256m --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  "$TAG"
echo "$TAG" > /opt/helmian-hands-mcp/current-tag
