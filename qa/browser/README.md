# Helmian Cloud browser QA scaffold

This directory is source-only browser scaffolding. `fixture-server.mjs` serves the checked-in Cloud shell and returns bounded local fixture responses; it does not contact Neon, Clerk/OIDC, providers, connectors, or any external service. Fixture Organization values are response data only and are never client selectors.

The Node unit/contract suite runs without browser dependencies. The Playwright smoke/visual suite requires, outside this repository:

1. Node.js 20 or newer.
2. `@playwright/test` available to the invoking environment.
3. A Chromium browser installed for Playwright.

Run it with `npx playwright test -c qa/browser/playwright.config.mjs`. The two smoke tests are browser-ready. The visual test is intentionally marked `fixme` until a deterministic baseline is generated and reviewed; no visual screenshot is claimed by the source/unit suite.
