# cora-sandbox

Cora sandbox service: page/app builder, RBAC+ABAC policy, prompt-injection guard,
connector contract, and a separation lint that keeps other tenant products out of this service.

Status: punch-list tasks 1, 2, 3, 10 only. Not deployed.

## Run tests
    npm test

## Run locally
    CORA_SANDBOX_PORT=8110 npm start
    curl http://127.0.0.1:8110/healthz   # {"ok":true}

The server binds to 127.0.0.1 by default. In Docker it listens on 0.0.0.0 inside the
container, so publish it only on loopback: `-p 127.0.0.1:8110:8110`. Caddy is the only public entry point.
