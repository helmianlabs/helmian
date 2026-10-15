// Vercel build step: copy the Helmian cloud admin backend (repo-root src/, sql/,
// web/cloud-admin/) next to the functions so api/helmian-admin.js can import it
// with the same relative layout it has in the repo.
import { cp, rm, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const repo = join(site, '..', '..');
const out = join(site, 'helmian-admin');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'web'), { recursive: true });
await cp(join(repo, 'src'), join(out, 'src'), { recursive: true });
await cp(join(repo, 'sql'), join(out, 'sql'), { recursive: true });
await cp(join(repo, 'web', 'cloud-admin'), join(out, 'web', 'cloud-admin'), { recursive: true });
console.log('bundled Helmian admin backend into', out);
