// Plugin bundles — Helmian's shelf of cloud plugins (plugin-install
// bite, 2026-11-09; Troy's ask: "two connectors and two plugins").
//
// A bundle here is the Agent Plugins 1.0 package (agent-plugins.org)
// carried as data: the root `plugin.json` manifest, the root
// `mcp.json`, and one SKILL.md text per skill under skills/<name>/.
// The 1.0 format deliberately defines NO install mechanism, trust
// model, or credential handling — Helmian supplies those (the
// install route, plugin-library-route.mjs; the install record,
// plugin-library.mjs over sql/080). What the format DOES fix is the
// package shape, and this module keeps exactly that shape so a
// bundle from this shelf is a bundle any compatible client reads:
//
//   - pluginJson permits the spec's closed field set only
//     ($schema, name, version, description, author, homepage,
//     repository, license, keywords, extensions). The one Helmian
//     extension rides under `extensions` — the spec's own place for
//     client-specific data — and maps each declared MCP server name
//     to the connector-catalog entry id it declares. The catalog
//     (connector-catalog.mjs) stays the one place an entry is
//     defined; the bundle DECLARES an entry, it never redefines one.
//   - mcpJson is the bundle's own copy of the server declarations
//     (explicit `type`, per the spec) — descriptive data for other
//     clients. Helmian's runtime never dials an mcp.json URL: the
//     connection, when a person makes one, is the catalog entry's,
//     through the connector library's own roads and gate.
//   - skills are full SKILL.md texts (frontmatter + body). Install
//     runs them through the skill library's established paste lift
//     (skill-library-route.mjs), so a bundle skill lands exactly the
//     way a pasted SKILL.md lands — the frontmatter name IS the
//     skill's slug, the frontmatter description fills the record.
//
// A bundle is a DECLARATION, never a connection and never a claim:
// installing one registers its skills and records the install; its
// MCP entries connect (or not) on the ordinary per-connector road,
// and the plugins read joins their live state from the connector
// library at read time.
import { parseFrontmatter } from '../agent/commands.mjs';

export const PLUGIN_MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const PLUGIN_MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
// The manifest extension key carrying Helmian's catalog mapping.
export const PLUGIN_ENTRY_IDS_EXTENSION = 'cloud.helmian';

// Plugin names are the names the composer carries (the attachable
// name law, installed-plugins.mjs): lowercase, one segment, and the
// same slug the skill store would accept for a skill id.
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const WEATHER_SKILL_MD = `---
name: reading-a-forecast
description: Turn National Weather Service tool output into a plain forecast answer: alerts first, then today, then the week.
---

# Reading a forecast

Use this when a message asks about weather and the Weather tools
(the National Weather Service server) are in play.

## The order of the answer

1. **Alerts first.** If the tools returned any active alert, warning,
   or watch for the place asked about, lead with it — what it is,
   where it applies, and when it expires — before any ordinary
   forecast. An alert the person needs is never buried under
   sunshine.
2. **Today next.** The current conditions and today's (and tonight's)
   forecast: temperature, precipitation chance, wind, in the units
   the tools returned.
3. **Then the week.** The coming days in brief — one line per day is
   enough unless the person asked for more.

## The honesty rules

- **Say the source.** The answer names the National Weather Service
  as where the numbers came from.
- **Never invent a number.** Every temperature, chance, and time in
  the answer must be one the tools actually returned. If the tools
  did not return it, the answer does not contain it — say what is
  missing instead ("the service did not return tonight's low").
- **Place is the tool call's, not a guess.** If the person did not
  name a place, ask for one, or use the place already settled in
  the conversation; never silently forecast for somewhere else.
- If the tools are not connected or return nothing, say so plainly —
  do not fall back to remembered weather.
`;

const GITHUB_REVIEW_SKILL_MD = `---
name: reviewing-a-pull-request
description: Review a pull request from its diff: read what changed, check the tests the PR names, summarize in plain words, and name what was not checked.
---

# Reviewing a pull request

Use this when a message asks for a review of a pull request and the
GitHub tools are in play.

## The work, in order

1. **Read the diff first.** Every changed file, what it did before,
   and what it does now. A summary written from the title or the
   description alone is not a review.
2. **Check the tests the PR names.** If the PR names tests (in its
   description, its checks, or the changed files), read whether
   they cover the change the diff makes — and say which named tests
   you actually looked at. Tests the PR does not name are not
   evidence about this change.
3. **Summarize in plain words.** What the change does, what could
   break, and what you would ask the author — in the words of the
   work, not in diff line numbers.

## The honesty rules

- **Name what was NOT checked.** Every review ends with the list:
  the files not read, the tests not run or not found, the behaviour
  never exercised. A review that hides its edges reads as stronger
  than it is.
- **Reading is different from running.** Unless a test actually ran
  in this turn, the review says the code was read, not verified.
- If the diff could not be fetched, say so and stop — never review
  a pull request from its title.
`;

function freezeBundle(bundle) {
  return Object.freeze({
    pluginJson: Object.freeze(bundle.pluginJson),
    mcpJson: Object.freeze(bundle.mcpJson),
    skills: Object.freeze(bundle.skills.map((s) => Object.freeze(s))),
  });
}

/** The catalog entry ids a bundle declares, in declaration order. */
export function bundleEntryIds(bundle) {
  const map = bundle?.pluginJson?.extensions?.[PLUGIN_ENTRY_IDS_EXTENSION]?.mcpEntryIds ?? {};
  return Object.values(map).map(String);
}

/** server name → catalog entry id, as the manifest declares it. */
export function bundleEntryIdMap(bundle) {
  return bundle?.pluginJson?.extensions?.[PLUGIN_ENTRY_IDS_EXTENSION]?.mcpEntryIds ?? {};
}

/**
 * The skills a bundle declares, as install-ready references: the id
 * and display fields come from the SKILL.md's own frontmatter (the
 * established parse — the frontmatter name IS the slug), the text
 * rides whole for the install's paste lift.
 */
export function bundleSkillRefs(bundle) {
  return (bundle?.skills ?? []).map((skill) => {
    const parsed = parseFrontmatter(skill.skillMd);
    return {
      id: typeof parsed.meta?.name === 'string' ? parsed.meta.name.trim() : '',
      name: typeof parsed.meta?.name === 'string' ? parsed.meta.name.trim() : '',
      description: typeof parsed.meta?.description === 'string' ? parsed.meta.description.trim() : '',
      skillMd: skill.skillMd,
    };
  });
}

/**
 * A bundle's shape, ruled once here so the shelf cannot quietly rot:
 * the manifest names the bundle and carries the spec's schema, every
 * declared MCP server has a catalog mapping and every mapping names
 * a declared server, and every skill's frontmatter names it with a
 * slug the skill store accepts. Throws a plain-words error.
 */
export function validateBundle(bundle) {
  const fail = (message) => { throw Object.assign(new Error(message), { status: 500 }); };
  const manifest = bundle?.pluginJson ?? {};
  if (manifest.$schema !== PLUGIN_MANIFEST_SCHEMA) fail('plugin bundle manifest does not name the Agent Plugins 1.0 schema');
  const name = String(manifest.name ?? '');
  if (!PLUGIN_NAME_PATTERN.test(name) || name.length > 64) fail(`plugin bundle name is not a carryable plugin name: "${name}"`);
  if (!String(manifest.version ?? '').trim()) fail(`plugin bundle "${name}" carries no version`);
  if (!String(manifest.description ?? '').trim()) fail(`plugin bundle "${name}" carries no description`);
  const servers = bundle?.mcpJson?.mcpServers ?? {};
  const serverNames = Object.keys(servers);
  if (!serverNames.length) fail(`plugin bundle "${name}" declares no MCP servers`);
  for (const serverName of serverNames) {
    const server = servers[serverName];
    if (!['stdio', 'streamable-http', 'sse'].includes(server?.type)) {
      fail(`plugin bundle "${name}" server "${serverName}" does not declare a transport type`);
    }
    if (server.type !== 'stdio' && !String(server?.url ?? '').trim()) {
      fail(`plugin bundle "${name}" server "${serverName}" declares no URL`);
    }
  }
  const entryIds = bundleEntryIdMap(bundle);
  for (const serverName of serverNames) {
    if (!String(entryIds[serverName] ?? '').trim()) {
      fail(`plugin bundle "${name}" server "${serverName}" has no catalog entry mapping`);
    }
  }
  for (const serverName of Object.keys(entryIds)) {
    if (!servers[serverName]) fail(`plugin bundle "${name}" maps undeclared server "${serverName}" to the catalog`);
  }
  const refs = bundleSkillRefs(bundle);
  if (!refs.length) fail(`plugin bundle "${name}" declares no skills`);
  for (const ref of refs) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(ref.id) || ref.id.length > 64) {
      fail(`plugin bundle "${name}" has a skill whose frontmatter name is not a skill slug: "${ref.id}"`);
    }
    if (!ref.description) fail(`plugin bundle "${name}" skill "${ref.id}" carries no frontmatter description`);
  }
  return bundle;
}

// ---------------------------------------------------------------- the shelf

const WEATHER_BUNDLE = freezeBundle({
  pluginJson: {
    $schema: PLUGIN_MANIFEST_SCHEMA,
    name: 'weather',
    version: '1.0.0',
    description: 'US weather from the National Weather Service: forecasts, alerts, and current conditions, answered the plain way.',
    author: { name: 'Helmian' },
    keywords: ['weather', 'forecast', 'alerts', 'national-weather-service'],
    extensions: {
      [PLUGIN_ENTRY_IDS_EXTENSION]: {
        mcpEntryIds: { weather: 'registry-weather' },
      },
    },
  },
  mcpJson: {
    $schema: PLUGIN_MCP_SCHEMA,
    mcpServers: {
      weather: { type: 'streamable-http', url: 'https://nws.caseyjhand.com/mcp' },
    },
  },
  skills: [{ name: 'reading-a-forecast', skillMd: WEATHER_SKILL_MD }],
});

const GITHUB_REVIEW_BUNDLE = freezeBundle({
  pluginJson: {
    $schema: PLUGIN_MANIFEST_SCHEMA,
    name: 'github-review',
    version: '1.0.0',
    description: 'Pull request reviews over the workspace’s GitHub connection: the diff read first, the tests the PR names checked, and what was not checked named.',
    author: { name: 'Helmian' },
    keywords: ['github', 'pull-request', 'code-review'],
    extensions: {
      [PLUGIN_ENTRY_IDS_EXTENSION]: {
        mcpEntryIds: { github: 'helmian-github' },
      },
    },
  },
  mcpJson: {
    $schema: PLUGIN_MCP_SCHEMA,
    mcpServers: {
      github: { type: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/' },
    },
  },
  skills: [{ name: 'reviewing-a-pull-request', skillMd: GITHUB_REVIEW_SKILL_MD }],
});

/** Helmian's plugin shelf: the bundles a workspace can install. */
export const PLUGIN_SHELF = Object.freeze([WEATHER_BUNDLE, GITHUB_REVIEW_BUNDLE].map(validateBundle));

/** One shelf bundle by its (canonical, lowercased) name, or null. */
export function pluginBundleByName(name) {
  const wanted = String(name ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return PLUGIN_SHELF.find((bundle) => bundle.pluginJson.name === wanted) ?? null;
}
