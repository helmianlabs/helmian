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
// src/cloud/envoy-reactions.mjs imports the emoji map by its repo-relative
// path (../../web/marketing/app/emoji-map.mjs), and burst 6's server files
// (envoy-reactions.mjs, user-profile.mjs) import the face library by the
// same path (../../web/marketing/app/face-library.mjs). Reproduce that exact
// layout inside the bundle, or the bundled module graph fails to resolve it
// and every helmian-admin function dies at import time.
await mkdir(join(out, 'web', 'marketing', 'app'), { recursive: true });
await cp(join(repo, 'web', 'marketing', 'app', 'emoji-map.mjs'), join(out, 'web', 'marketing', 'app', 'emoji-map.mjs'));
await cp(join(repo, 'web', 'marketing', 'app', 'face-library.mjs'), join(out, 'web', 'marketing', 'app', 'face-library.mjs'));
console.log('bundled Helmian admin backend into', out);
