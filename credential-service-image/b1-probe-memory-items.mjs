// B1 CONFIRMATION PROBE — READ-ONLY.
// Live schema of public.memory_items in Neon.
// Pattern copied from ~/workspace/profile-sync-fix/neon-check-sync-2026-11-05.mjs:
// runs INSIDE helmian-credential-service, uses HELMION_DATABASE_URL,
// endpoint guard ep-proud-truth-a69e8vg4. SELECT / catalog reads only.
import pg from 'pg';

const url = process.env.HELMION_DATABASE_URL;
if (!url) { console.log('NO_URL'); process.exit(1); }
const host = new URL(url).hostname;
const endpoint = host.split('.')[0];
console.log('endpoint-guard(ep-proud-truth-a69e8vg4):', endpoint.startsWith('ep-proud-truth-a69e8vg4') ? 'PASS' : 'FAIL');
if (!endpoint.startsWith('ep-proud-truth-a69e8vg4')) process.exit(2);

const pool = new pg.Pool({ connectionString: url });
try {
  const meta = await pool.query(
    `select current_database() as db, current_user as db_user, version() as version`,
  );
  console.log('db meta:', JSON.stringify(meta.rows[0], null, 1));

  // Exact column types via pg_catalog (format_type keeps e.g. vector(1536),
  // varchar lengths, array suffixes that information_schema flattens).
  const cols = await pool.query(
    `select a.attnum as ordinal,
            a.attname as column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) as full_type,
            a.attnotnull as not_null,
            pg_get_expr(d.adbin, d.adrelid) as column_default
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      where n.nspname = 'public' and c.relname = 'memory_items'
      order by a.attnum`,
  );
  console.log('public.memory_items columns (pg_catalog):', JSON.stringify(cols.rows, null, 1));

  // information_schema cross-check (data_type / udt_name / lengths).
  const isCols = await pool.query(
    `select ordinal_position, column_name, data_type, udt_schema, udt_name,
            character_maximum_length, numeric_precision, numeric_scale,
            is_nullable, column_default
       from information_schema.columns
      where table_schema = 'public' and table_name = 'memory_items'
      order by ordinal_position`,
  );
  console.log('public.memory_items columns (information_schema):', JSON.stringify(isCols.rows, null, 1));

  const exists = await pool.query(
    `select to_regclass('public.memory_items') as regclass`,
  );
  console.log('to_regclass public.memory_items:', JSON.stringify(exists.rows[0]));

  if (cols.rows.length > 0) {
    const cnt = await pool.query(`select count(*)::bigint as row_count from public.memory_items`);
    console.log('public.memory_items row_count:', JSON.stringify(cnt.rows[0]));
    const cons = await pool.query(
      `select conname, pg_get_constraintdef(oid) as definition
         from pg_constraint
        where conrelid = 'public.memory_items'::regclass
        order by conname`,
    );
    console.log('public.memory_items constraints:', JSON.stringify(cons.rows, null, 1));
    const idx = await pool.query(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'memory_items' order by indexname`,
    );
    console.log('public.memory_items indexes:', JSON.stringify(idx.rows, null, 1));
  }

  // Fallback / mismatch diagnostics: every table named like memory* in any schema.
  const memTables = await pool.query(
    `select table_schema, table_name from information_schema.tables
      where table_name ilike '%memory%' order by table_schema, table_name`,
  );
  console.log('all tables named like %memory%:', JSON.stringify(memTables.rows, null, 1));

  const now = await pool.query('select now() as db_now');
  console.log('db now:', JSON.stringify(now.rows[0]));
} finally {
  await pool.end();
}
