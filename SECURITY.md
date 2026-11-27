# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Email helmianlabs@gmail.com with "SECURITY" in the subject.

Include what you found, where (file, URL or endpoint), how to reproduce it,
and what an attacker could do with it. Please give us a reasonable time to
fix it before you talk about it publicly.

## What is in scope

- This repository's code: the `helmion` CLI and hooks, Executive Guard
  (`executive-guard/`), the Helmian Guard extension (`extension/`), Site
  Guard (`src/cloud/site-guard.mjs`), the Hands hub, door and PC spoke
  (`hands-mcp/`, `door/`, `src/hands/`), the bridges, and the web app and
  API in `web/marketing/`.
- The hosted service at helmian.cloud and door.helmian.cloud.

Out of scope: Scribe (a separate product with its own repository), other
DairyForge products, and third-party services Helmian connects to.

## Supported versions

Only the latest code on `main` and the latest published release are
supported. Desktop and spoke installers are currently not code-signed;
download them only from this repository's Releases page or helmian.cloud.

## Secrets in this repository

No real secrets should be committed. `.env.example` files hold placeholders
only. Strings that look like keys inside `test/` files are fake fixtures used
to test redaction. If you find a real credential in the code or history,
report it as above.
