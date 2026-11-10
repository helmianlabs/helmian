// Plugin library routes (plugin-install bite, 2026-11-09): the
// cloud plugin shelf's install / uninstall / read API —
//
//   GET  /api/admin/plugins            → { valid: true, plugins: [row], unavailable: [..], shelf: [bundle] }
//     The workspace's plugins, BOTH truths in one list: the cloud
//     bundles installed from Helmian's shelf (the install records,
//     sql/080) and the PC bridge's installed plugins (the read
//     installed-plugins.mjs has always served — the bridge list is
//     read through the same loader here, so shadowing the admin
//     plane's own handler for this path loses nothing). A cloud row
//     carries the bundle's declared entries with their LIVE
//     connection state joined from the connector library, and its
//     declared skills with their presence in the skill library.
//     A workspace with neither answers the honest empty list —
//     the plus menu's "No plugins are installed." stands on it.
//     Beside the rows rides the SHELF itself: every bundle Helmian
//     carries, in the bundle's own names and words (name, version,
//     description, its declared entries and skills), so the Manage
//     surface's Plugins tab can render the catalog a person could
//     install from — before this field the read carried only what
//     was already installed, and the tab could name nothing to
//     install. Installed state never rides a shelf row; the face
//     joins the two by name against the plugins rows above.
//   POST /api/admin/plugins/install    { name } → { valid: true, plugin }
//     Install a shelf bundle: its skills are registered into the
//     workspace's skill library through the EXISTING skills write
//     path (createSkill, under the provenance subject
//     'plugin:<name>'), and the install is recorded. NO connector
//     connection is created — the bundle's MCP entries are
//     declarations; connecting one is the ordinary per-connector
//     road. A bundle declaring an entry the catalog does not carry
//     fails before anything is written; a skill id the workspace
//     already holds under another author fails the same way, and
//     anything this attempt did create is removed again.
//   POST /api/admin/plugins/uninstall  { name } → { valid: true, removed }
//     Removes the install record and the skills the install
//     registered — only its own: a skill whose provenance is no
//     longer the plugin's (the person deleted it and authored
//     their own under the same id) is theirs and stays.
//
// Scoping, exactly like the sibling skill routes: member auth via
// activeTenantActor, the tenant from the actor's membership, the
// installer from the actor's subject. Authority selectors in the
// query or the body are refused (400), never honoured. Writes
// refuse the auditor role (403) — an auditor reads, never installs.
//
// Wiring note: same shape as the sibling routes — live-admin.mjs is
// frozen at the push size limit, so the route hangs off the
// envoy-ably delegate hook with its own lazy pool (same env var,
// same ssl rule), beside handleSkillLibraryRoute. The delegate
// answers GET /api/admin/plugins before the admin plane's own
// bridge-only handler (live-admin.mjs), which remains the fallback
// for any deployment that does not load the delegate.
import { Pool } from 'pg';
import { createPluginLibraryStore } from './plugin-library.mjs';
import {
  PLUGIN_SHELF,
  pluginBundleByName,
  bundleEntryIds,
  bundleSkillRefs,
  validateBundle,
} from './plugin-bundles.mjs';
import { createSkillLibraryStore } from './skill-library.mjs';
import { liftSkillPaste } from './skill-library-route.mjs';
import { LIVE_SEATS, catalogEntriesForSeat, catalogEntryById, NATIVE_STATE_SOURCES } from './connector-catalog.mjs';
import { createConnectorLibraryStore } from './connector-library.mjs';
import {
  joinedState,
  createToolConnectionSurface,
  createChannelRepoLinkSurface,
} from './connector-library-read.mjs';
import { createToolConnectionsStore } from './tool-connections.mjs';
import { createEnvoyStore } from './envoy-chat.mjs';
import { listInstalledPlugins, installedPluginsWorkspace } from './installed-plugins.mjs';

export const PLUGINS_PATH = '/api/admin/plugins';
export const PLUGIN_INSTALL_PATH = '/api/admin/plugins/install';
export const PLUGIN_UNINSTALL_PATH = '/api/admin/plugins/uninstall';

// Authority selectors are never accepted on these routes: the tenant
// is the actor's membership and the installer is the actor's subject.
const AUTHORITY_SELECTORS = Object.freeze([
  'tenant_id', 'tenantId', 'organization_id', 'plant_id', 'facility_id',
  'person_id', 'personId', 'subject',
]);

let sharedPool = null;
function getPool() {
  if (!sharedPool) {
    const connectionString = String(process.env.HELMION_DATABASE_URL ?? '').trim();
    if (!connectionString) throw Object.assign(new Error('database not configured'), { status: 503 });
    sharedPool = new Pool({ connectionString, ssl: connectionString.includes('sslmode=disable') ? false : undefined, max: 3 });
  }
  return sharedPool;
}

const fail = (status, code, message = code) => Object.assign(new Error(message), { status, code });

/** The provenance subject a bundle's skills are authored under. */
export function pluginProvenanceSubject(name) {
  return `plugin:${String(name ?? '').trim().toLowerCase()}`;
}

// The headline-state ranking the connector library read rules by
// (connector-library-read.mjs's STATE_RANK): across a declared
// entry's seats, the strongest state is the entry's state.
const STATE_RANK = Object.freeze({ connected: 0, 'needs-reconnect': 1, 'not-connected': 2, 'disabled-by-owner': 3 });

const STATE_WORDS = Object.freeze({
  connected: 'connected',
  'needs-reconnect': 'needs reconnecting before use',
  'disabled-by-owner': 'turned off by the owner',
});
const stateWords = (state) => STATE_WORDS[state] ?? 'not connected yet';

/**
 * The plain line the menu draws under a cloud plugin's name: what
 * the bundle brings, from the read's own data — each declared
 * entry's tools with their live state, and the skills it put in
 * the workspace's library. Never a claim the data does not carry:
 * an entry that is not connected says so in the line.
 */
export function pluginBringsLine({ entries = [], skills = [] } = {}) {
  const parts = [];
  for (const entry of entries) {
    parts.push(`the ${entry.name} tools — ${stateWords(entry.state)}`);
  }
  const present = skills.filter((s) => s.installed !== false);
  if (present.length) {
    const names = present.map((s) => s.name ?? s.id).join(', ');
    parts.push(`${present.length === 1 ? 'the' : ''} ${names} skill${present.length === 1 ? '' : 's'} in this workspace’s skill library`);
  }
  if (!parts.length) return 'Installed; adds nothing to this workspace yet.';
  const text = parts.join(', plus ');
  return `Brings ${text}.`;
}

// ------------------------------------------------------------- catalog help

function catalogEntryExists(entryId) {
  return LIVE_SEATS.some((seatId) => catalogEntryById(seatId, entryId) !== null);
}

// Catalog definitions are code data: an entry's display name is the
// same on every seat that carries it. Resolved once here.
const catalogEntryNameCache = new Map();
function catalogEntryName(entryId) {
  if (!catalogEntryNameCache.has(entryId)) {
    let name = null;
    for (const seatId of LIVE_SEATS) {
      const entry = catalogEntryById(seatId, entryId);
      if (entry) { name = entry.name; break; }
    }
    catalogEntryNameCache.set(entryId, name);
  }
  return catalogEntryNameCache.get(entryId);
}

// ------------------------------------------------------- production states

/**
 * The declared entries' live states for one person in one tenant,
 * ruled by the connector library's ONE state join (joinedState,
 * connector-library-read.mjs) — the plugin read does not invent a
 * second state logic. Per seat the entry sits on: the person's
 * connection, the person's mirror report, and for the Helmian
 * natives their own sources (the tool-connections surface, the
 * tenant's channel repo links). The strongest state across seats
 * is the entry's headline.
 *
 * Deliberately NOT the seat-library read (readSeatLibrary): that
 * read seeds and heals the catalog on the way through, and a
 * plugins read must not write. An entry the tenant's library does
 * not hold yet reads 'not-connected' — the truth for it; the
 * Connectors tab's own read does the seeding when the person goes
 * there.
 */
async function productionEntryStates(pool, tenantId, actor, entryIds) {
  const wanted = new Set(entryIds);
  const best = new Map();
  for (const id of entryIds) best.set(id, { state: 'not-connected', accountIdentity: null });
  if (!wanted.size) return best;
  const libraryStore = createConnectorLibraryStore(pool);
  const seats = LIVE_SEATS.filter((seatId) => catalogEntriesForSeat(seatId).some((e) => wanted.has(e.id)));
  let toolSurface = null;
  let repoLinks = null;
  for (const seatId of seats) {
    const [entries, connections, mirrors] = await Promise.all([
      libraryStore.listEntries(tenantId, seatId),
      libraryStore.listConnections(tenantId, { personId: actor.subject, seatId }),
      libraryStore.listMirrors(tenantId, { personId: actor.subject, seatId }),
    ]);
    const connectionByEntry = new Map(connections.map((c) => [c.entryId, c]));
    const mirrorByEntry = new Map(mirrors.map((m) => [m.entryId, m]));
    for (const entry of entries) {
      if (!wanted.has(entry.id)) continue;
      let nativeSurface;
      let entryRepoLinks;
      const source = NATIVE_STATE_SOURCES[entry.id];
      if (source?.stateSource === 'tool-connections') {
        toolSurface ??= createToolConnectionSurface(createToolConnectionsStore(pool));
        nativeSurface = await toolSurface.surfaceFor(tenantId, source.serviceId, {});
      }
      if (source?.repoLinks) {
        if (!repoLinks) {
          repoLinks = await createChannelRepoLinkSurface(createEnvoyStore(pool)).linksFor(actor);
        }
        entryRepoLinks = repoLinks;
      }
      const joined = joinedState(entry, {
        connection: connectionByEntry.get(entry.id),
        mirror: mirrorByEntry.get(entry.id),
        nativeSurface,
        repoLinks: entryRepoLinks,
      });
      const standing = best.get(entry.id);
      if (!standing || STATE_RANK[joined.state] < STATE_RANK[standing.state]) {
        best.set(entry.id, { state: joined.state, accountIdentity: joined.accountIdentity ?? null });
      }
    }
  }
  return best;
}

// ------------------------------------------------------------ install acts

/**
 * Install one shelf bundle into a workspace. Rules, in order:
 *   1. The bundle must be whole (validateBundle — a shelf defect is
 *      a 500, named as such, never a half install).
 *   2. An install record at the same version is the standing
 *      install — reinstalling answers it, unchanged (idempotent).
 *      A record at a DIFFERENT version is a 409: uninstall first.
 *   3. Every declared entry must exist in the connector catalog —
 *      an unknown entry fails the install before anything is
 *      written, with the entry named.
 *   4. The bundle's skills register through the skill store, under
 *      the plugin's provenance subject, scope 'blanket' (a plugin's
 *      skill is the workspace's, for every seat — the skill
 *      library's own scope for that). A skill already standing
 *      under the plugin's provenance is left as it stands; a skill
 *      id the workspace holds under any OTHER author is a 409, and
 *      every skill this attempt created is removed again — a
 *      failed install leaves nothing behind.
 *   5. The record is written last, from the manifest as installed.
 * No connector connection is created at any step.
 */
export async function installPlugin({ plugins, skills, entryExists }, { tenantId, actor, bundle }) {
  validateBundle(bundle);
  const manifest = bundle.pluginJson;
  const name = manifest.name;
  const marker = pluginProvenanceSubject(name);
  const standing = await plugins.getPlugin(tenantId, name);
  if (standing) {
    if (standing.version === manifest.version) {
      return { record: standing, alreadyInstalled: true, createdSkills: [] };
    }
    throw fail(409, 'PLUGIN_VERSION_CONFLICT',
      `version ${standing.version} of the ${name} plugin is already installed in this workspace — uninstall it before installing version ${manifest.version}`);
  }
  const entryIds = bundleEntryIds(bundle);
  for (const entryId of entryIds) {
    if (!entryExists(entryId)) {
      throw fail(400, 'PLUGIN_ENTRY_UNKNOWN',
        `the ${name} plugin declares a connector Helmian does not carry: "${entryId}" — nothing was installed`);
    }
  }
  const skillRefs = bundleSkillRefs(bundle);
  const createdSkills = [];
  try {
    for (const skill of bundle.skills) {
      const lifted = liftSkillPaste({ body: skill.skillMd });
      const skillId = String(lifted.id ?? '');
      const existing = skillId ? await skills.getSkill(tenantId, skillId) : null;
      if (existing) {
        if (existing.createdBy !== marker) {
          throw fail(409, 'PLUGIN_SKILL_CONFLICT',
            `this workspace already has a skill named "${skillId}" that the ${name} plugin did not install — nothing was installed`);
        }
        continue;
      }
      const created = await skills.createSkill(tenantId, marker, {
        id: lifted.id,
        name: lifted.name,
        description: lifted.description,
        body: lifted.body,
        scope: 'blanket',
        seatIds: [],
      });
      createdSkills.push(created.id);
    }
    const record = await plugins.recordInstall(tenantId, actor.subject, {
      name,
      version: manifest.version,
      description: manifest.description ?? null,
      manifest,
      mcpEntryIds: entryIds,
      skillIds: skillRefs.map((s) => s.id),
    });
    return { record, alreadyInstalled: false, createdSkills };
  } catch (error) {
    for (const skillId of createdSkills) {
      try { await skills.removeSkill(tenantId, skillId); } catch { /* rollback is best-effort; the failure itself rides */ }
    }
    throw error;
  }
}

/**
 * Uninstall one plugin from a workspace: the record goes, and the
 * skills the install registered go — only its own. Provenance is
 * the test: a skill id whose standing record no longer carries the
 * plugin's mark (the person deleted the plugin's skill and
 * authored their own under the same id) is the person's skill now
 * and is left standing; a skill already gone is simply gone.
 */
export async function uninstallPlugin({ plugins, skills }, { tenantId, name }) {
  const record = await plugins.getPlugin(tenantId, name);
  if (!record) {
    throw fail(404, 'PLUGIN_NOT_INSTALLED', `the ${name} plugin is not installed in this workspace`);
  }
  const marker = pluginProvenanceSubject(record.name);
  const removedSkills = [];
  for (const skillId of record.skillIds) {
    const skill = await skills.getSkill(tenantId, skillId);
    if (skill && skill.createdBy === marker) {
      await skills.removeSkill(tenantId, skillId);
      removedSkills.push(skillId);
    }
  }
  const removed = await plugins.removePlugin(tenantId, record.name);
  return { record: removed ?? record, removedSkills };
}

// ---------------------------------------------------------------- read rows

/**
 * One install record → its plugins-read row. The menu-compatible
 * fields ride first (name, version, brings — the shape
 * envoy-workspace.js renders today), then the brief's data: the
 * manifest's description, the declared entries with their live
 * state joined from the connector library, and the declared skills
 * with their presence in the skill library (a skill the person
 * deleted reads installed: false — the row never claims it stands).
 */
export function installedPluginBundleRow(record, { entryStates = new Map(), skillsById = new Map(), shelf = PLUGIN_SHELF } = {}) {
  const entries = (record.mcpEntryIds ?? []).map((entryId) => {
    const joined = entryStates.get(entryId) ?? { state: 'not-connected', accountIdentity: null };
    return {
      entryId,
      name: catalogEntryName(entryId) ?? entryId,
      state: joined.state,
      accountIdentity: joined.accountIdentity ?? null,
    };
  });
  const bundle = shelf.find((b) => b.pluginJson.name === record.name) ?? null;
  const refById = new Map((bundle ? bundleSkillRefs(bundle) : []).map((s) => [s.id, s]));
  const skills = (record.skillIds ?? []).map((skillId) => {
    const standing = skillsById.get(skillId);
    const ref = refById.get(skillId);
    return {
      id: skillId,
      name: standing?.name ?? ref?.name ?? skillId,
      description: standing?.description ?? ref?.description ?? null,
      installed: Boolean(standing),
    };
  });
  return Object.freeze({
    name: record.name,
    version: record.version,
    description: record.description ?? null,
    source: 'helmian-plugin',
    brings: pluginBringsLine({ entries, skills }),
    tools: entries.length > 0,
    commands: skills.length > 0,
    entries: Object.freeze(entries),
    skills: Object.freeze(skills),
    installedBy: record.installedBy,
    installedAt: record.installedAt,
  });
}

// ---------------------------------------------------------------- the route

function productionDeps() {
  const pool = getPool();
  return {
    plugins: createPluginLibraryStore(pool),
    skills: createSkillLibraryStore(pool),
    entryExists: catalogEntryExists,
    entryStates: (tenantId, actor, entryIds) => productionEntryStates(pool, tenantId, actor, entryIds),
    bridgeList: async () => listInstalledPlugins({ workspace: installedPluginsWorkspace(process.env) }),
    shelf: PLUGIN_SHELF,
  };
}

// Route delegate. Returns false when the request is not ours.
// Stores and lists are injectable for tests; production builds them
// from the lazy pool and the process workspace.
export async function handlePluginLibraryRoute({
  request,
  response,
  requestUrl,
  activeTenantActor,
  send,
  TenantAuthorizationError,
  readJson,
  plugins = null,
  skills = null,
  entryExists = null,
  entryStates = null,
  bridgeList = null,
  shelf = null,
} = {}) {
  const path = requestUrl?.pathname ?? '';
  const isRead = path === PLUGINS_PATH;
  const isInstall = path === PLUGIN_INSTALL_PATH;
  const isUninstall = path === PLUGIN_UNINSTALL_PATH;
  if (!isRead && !isInstall && !isUninstall) return false;

  const reply = (status, body) => send(response, status, JSON.stringify(body));
  const failure = (error) => {
    const knownStatus = [400, 403, 404, 409, 503].includes(error?.status) ? error.status : null;
    const status = knownStatus ?? (error instanceof TenantAuthorizationError ? 403 : 503);
    const code = error?.code ?? (status === 403 ? 'PLUGINS_MEMBERSHIP_REQUIRED'
      : status === 404 ? 'PLUGIN_NOT_FOUND'
      : status === 409 ? 'PLUGIN_CONFLICT'
      : status === 503 ? 'PLUGINS_UNAVAILABLE'
      : status === 400 ? 'PLUGIN_INVALID' : 'PLUGINS_FAILED');
    reply(status, { valid: false, code });
  };

  let deps;
  try {
    if (plugins && skills && entryExists && entryStates && bridgeList && shelf) {
      deps = { plugins, skills, entryExists, entryStates, bridgeList, shelf };
    } else {
      const prod = productionDeps();
      deps = {
        plugins: plugins ?? prod.plugins,
        skills: skills ?? prod.skills,
        entryExists: entryExists ?? prod.entryExists,
        entryStates: entryStates ?? prod.entryStates,
        bridgeList: bridgeList ?? prod.bridgeList,
        shelf: shelf ?? prod.shelf,
      };
    }
  } catch { reply(503, { valid: false, code: 'PLUGINS_UNAVAILABLE' }); return true; }

  const allowed = isRead ? ['GET'] : ['POST'];
  if (!allowed.includes(request.method)) { reply(405, { valid: false, code: 'METHOD_NOT_ALLOWED' }); return true; }

  try {
    if (AUTHORITY_SELECTORS.some((key) => requestUrl.searchParams.has(key))) {
      throw fail(400, 'PLUGINS_SELECTOR_INVALID', 'authority selector is not accepted');
    }
    let input = null;
    if (request.method === 'POST') {
      try { input = (await readJson(request)) ?? {}; }
      catch { throw fail(400, 'PLUGIN_BODY_INVALID', 'request body is not valid JSON'); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw fail(400, 'PLUGIN_BODY_INVALID', 'request body must be an object');
      }
      if (AUTHORITY_SELECTORS.some((key) => key in input)) {
        throw fail(400, 'PLUGINS_SELECTOR_INVALID', 'authority selector is not accepted');
      }
    }
    const actor = await activeTenantActor(request);
    const write = request.method !== 'GET';
    if (write && String(actor.role ?? '').toLowerCase() === 'auditor') {
      throw fail(403, 'PLUGIN_ROLE_FORBIDDEN', 'an auditor reads plugins but does not install them');
    }

    if (isRead) {
      const records = await deps.plugins.listPlugins(actor.tenantId);
      const entryIds = [...new Set(records.flatMap((r) => r.mcpEntryIds ?? []))];
      const states = entryIds.length
        ? await deps.entryStates(actor.tenantId, actor, entryIds)
        : new Map();
      const skillRows = records.length ? await deps.skills.listSkills(actor.tenantId) : [];
      const skillsById = new Map(skillRows.map((s) => [s.id, s]));
      const cloudRows = records.map((record) => installedPluginBundleRow(record, {
        entryStates: states, skillsById, shelf: deps.shelf,
      }));
      let bridge = { plugins: [], unavailable: [] };
      try {
        bridge = await deps.bridgeList();
      } catch {
        bridge = { plugins: [], unavailable: [{ name: null, message: 'the bridge plugin list could not be read' }] };
      }
      const cloudNames = new Set(cloudRows.map((r) => r.name));
      const bridgeRows = (bridge.plugins ?? []).filter((p) => !cloudNames.has(String(p?.name ?? '').toLowerCase()));
      reply(200, {
        valid: true,
        plugins: [...cloudRows, ...bridgeRows],
        unavailable: bridge.unavailable ?? [],
        shelf: deps.shelf.map((bundle) => ({
          name: bundle.pluginJson.name,
          version: bundle.pluginJson.version,
          description: bundle.pluginJson.description,
          entries: bundleEntryIds(bundle).map((entryId) => ({
            entryId,
            name: catalogEntryName(entryId) ?? entryId,
          })),
          skills: bundleSkillRefs(bundle).map(({ id, name, description }) => ({
            id,
            name,
            description,
          })),
        })),
      });
      return true;
    }

    const name = String(input?.name ?? '').trim().toLowerCase();
    if (!name) throw fail(400, 'PLUGIN_NAME_REQUIRED', 'a plugin name is required');

    if (isInstall) {
      const bundle = deps.shelf.find((b) => b.pluginJson.name === name) ?? null;
      if (!bundle) throw fail(404, 'PLUGIN_NOT_ON_SHELF', `Helmian's shelf carries no plugin named "${name}"`);
      const { record, alreadyInstalled } = await installPlugin(deps, { tenantId: actor.tenantId, actor, bundle });
      const states = await deps.entryStates(actor.tenantId, actor, record.mcpEntryIds ?? []);
      const skillRows = await deps.skills.listSkills(actor.tenantId);
      const row = installedPluginBundleRow(record, {
        entryStates: states,
        skillsById: new Map(skillRows.map((s) => [s.id, s])),
        shelf: deps.shelf,
      });
      reply(200, { valid: true, plugin: row, alreadyInstalled });
      return true;
    }

    // Uninstall: the record is the authority, not the shelf — a
    // plugin whose bundle left the shelf still uninstalls.
    const { record, removedSkills } = await uninstallPlugin(deps, { tenantId: actor.tenantId, name });
    reply(200, {
      valid: true,
      removed: { name: record.name, version: record.version, removedSkills },
    });
    return true;
  } catch (error) { failure(error); }
  return true;
}
