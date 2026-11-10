// Plugin library (plugin-install bite, 2026-11-09): the store over
// helmion.workspace_plugins (sql/080) — the record that a cloud
// plugin bundle (plugin-bundles.mjs) is installed in a workspace.
//
// A SIBLING of skill-library.mjs, in its exact discipline: same
// pool, same tenant-transaction pattern, same helmion schema, same
// plain-words error idiom, reads that answer empty when the table
// is not there yet (42P01) and writes that say so (503).
//
// WHAT THIS STORE IS NOT: it holds no skill text (the bundle's
// skills live in helmion.skills, authored under the provenance
// subject 'plugin:<name>'), and no connector state (the bundle's
// declared entries live in the connector library; their state is
// joined at read time by the route, never copied here). The row is
// the install RECORD — what was installed, which version, the
// manifest as installed, the entry ids it declared, the skill ids
// it registered, and who installed it. Uninstall rules itself by
// this record alone: those skill ids, and only while they still
// carry the plugin's provenance.

export const PLUGIN_NAME_MAX_CHARS = 64;
export const PLUGIN_VERSION_MAX_CHARS = 32;
export const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}
function isMissingTable(error) {
  return error?.code === '42P01';
}
function storeUnavailable(error) {
  if (isMissingTable(error)) return Object.assign(new Error('plugin library store unavailable'), { status: 503 });
  return error;
}

function requireSubject(subject) {
  if (!subject || typeof subject !== 'string') throw badRequest('installer subject is required');
  return subject;
}

function validateName(value) {
  const name = String(value ?? '').trim().toLowerCase();
  if (name.length > PLUGIN_NAME_MAX_CHARS || !PLUGIN_NAME_PATTERN.test(name)) {
    throw badRequest('plugin name is invalid: a lowercase slug of at most 64 characters');
  }
  return name;
}

function validateStringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v.trim())) {
    throw badRequest(`${field} must be a list of names`);
  }
  return [...new Set(value.map((v) => v.trim()))];
}

// ------------------------------------------------------------------ row map

function pluginOf(row) {
  if (!row) return null;
  return {
    name: row.name,
    version: row.version,
    description: row.description ?? null,
    manifest: row.manifest && typeof row.manifest === 'object' ? row.manifest : {},
    mcpEntryIds: Array.isArray(row.mcp_entry_ids) ? row.mcp_entry_ids : [],
    skillIds: Array.isArray(row.skill_ids) ? row.skill_ids : [],
    installedBy: row.installed_by,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

// --------------------------------------------------------------------- store

export function createPluginLibraryStore(pool) {
  const withTenant = async (tenantId, fn) => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`select set_config('helmion.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('commit');
      return out;
    } catch (error) {
      try { await client.query('rollback'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  };

  const wherePlugin = `tenant_id = current_setting('helmion.tenant_id', true) and name = $1`;

  async function readPlugin(client, name) {
    const r = await client.query(
      `select * from helmion.workspace_plugins where ${wherePlugin}`,
      [name],
    );
    return r.rows[0] ?? null;
  }

  return {
    /**
     * Record a bundle's install in the tenant's workspace. The
     * install route rules the act (shelf, version, skill conflicts)
     * before this is called; the store keeps the record — an upsert,
     * so a re-record of the same name refreshes the standing row
     * rather than duplicating it.
     */
    async recordInstall(tenantId, subject, input = {}) {
      requireSubject(subject);
      const name = validateName(input?.name);
      const version = String(input?.version ?? '').trim();
      if (!version || version.length > PLUGIN_VERSION_MAX_CHARS) throw badRequest('plugin version is required');
      if (!input?.manifest || typeof input.manifest !== 'object' || Array.isArray(input.manifest)) {
        throw badRequest('plugin manifest is required');
      }
      const description = input.description === undefined || input.description === null
        ? null
        : String(input.description).trim() || null;
      const mcpEntryIds = validateStringList(input.mcpEntryIds, 'mcpEntryIds');
      const skillIds = validateStringList(input.skillIds, 'skillIds');
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `insert into helmion.workspace_plugins
               (tenant_id, name, version, description, manifest, mcp_entry_ids, skill_ids, installed_by)
             values (current_setting('helmion.tenant_id', true), $1, $2, $3, $4, $5, $6, $7)
             on conflict (tenant_id, name) do update
               set version = excluded.version,
                   description = excluded.description,
                   manifest = excluded.manifest,
                   mcp_entry_ids = excluded.mcp_entry_ids,
                   skill_ids = excluded.skill_ids,
                   installed_by = excluded.installed_by,
                   updated_at = now()
             returning *`,
            [name, version, description, JSON.stringify(input.manifest), mcpEntryIds, skillIds, subject],
          );
          return pluginOf(r.rows[0]);
        });
      } catch (error) { throw storeUnavailable(error); }
    },

    /** One installed plugin by name, or null. Another tenant's record reads as absent. */
    async getPlugin(tenantId, name) {
      const wanted = validateName(name);
      try {
        return await withTenant(tenantId, async (client) => pluginOf(await readPlugin(client, wanted)));
      } catch (error) {
        if (isMissingTable(error)) return null;
        throw error;
      }
    },

    /** The workspace's installed plugins, by name. Starts empty and honest. */
    async listPlugins(tenantId) {
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `select * from helmion.workspace_plugins
              where tenant_id = current_setting('helmion.tenant_id', true)
              order by name`,
          );
          return r.rows.map(pluginOf);
        });
      } catch (error) {
        if (isMissingTable(error)) return [];
        throw error;
      }
    },

    /**
     * Remove the install record. Returns the removed record, or
     * null when there was nothing to remove. The bundle's skills
     * are the route's to remove first (only the ones still carrying
     * the plugin's provenance) — this store never reaches into the
     * skill library.
     */
    async removePlugin(tenantId, name) {
      const wanted = validateName(name);
      try {
        return await withTenant(tenantId, async (client) => {
          const r = await client.query(
            `delete from helmion.workspace_plugins where ${wherePlugin} returning *`,
            [wanted],
          );
          return pluginOf(r.rows[0] ?? null);
        });
      } catch (error) { throw storeUnavailable(error); }
    },
  };
}
