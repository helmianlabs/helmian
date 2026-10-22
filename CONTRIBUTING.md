# Contributing to Helmian

Thanks for taking a look.

1. Run `npm install` and `npm run verify` before and after your change. It needs no database, no API key, and no network.
2. For the marketing site and web app, run `npm install` and `npm run check` in `web/marketing/`.
3. Keep changes small and say why in the pull request. Anything that touches leases, confirmations, the audit trail, or Guard policy needs a test.
4. Never commit secrets, connection strings, or `.env` files. `.env.example` holds placeholders only.
5. The CLI and env vars use the spelling `helmion`. Please don't rename them; the product name is Helmian.

Contributions are accepted under the repository [LICENSE](LICENSE) (Business Source License 1.1).

Questions: open an issue, or email helmianlabs@gmail.com.
