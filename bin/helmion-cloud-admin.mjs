#!/usr/bin/env node
import { startHelmianCloudAdmin, DEFAULT_CLOUD_ADMIN_PORT } from '../src/cloud/admin-server.mjs';
const args = process.argv.slice(2); const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : '127.0.0.1'; const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : DEFAULT_CLOUD_ADMIN_PORT;
const server = await startHelmianCloudAdmin({ host, port });
process.stdout.write(`Helmian Cloud sample admin: ${server.url}\n`);
process.on('SIGINT', () => server.close().then(() => process.exit(0)));
