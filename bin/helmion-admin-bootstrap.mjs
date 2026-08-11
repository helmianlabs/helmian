#!/usr/bin/env node
import { bootstrapHelmianAdminOwner } from '../src/cloud/admin-bootstrap.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
};

try {
  const result = await bootstrapHelmianAdminOwner({
    tenantId: value('--tenant-id'),
    displayName: value('--display-name'),
    subject: value('--subject'),
    confirmed: args.includes('--confirm'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`Helmian admin bootstrap refused: ${error.message}\n`);
  process.exitCode = 1;
}
