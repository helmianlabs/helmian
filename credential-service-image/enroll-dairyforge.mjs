const url = process.env.HELMION_DATABASE_URL || process.env.DATABASE_URL;
const { default: pg } = await import('pg');
const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 1 });
const t = await pool.query("insert into helmion.tenants (tenant_id, display_name) values ('dairyforge', 'DairyForge customer org dairyforge — Author core custody (Helmian modular core)') returning tenant_id, display_name");
console.log('TENANT:', JSON.stringify(t.rows));
const m = await pool.query("insert into helmion.tenant_memberships (tenant_id, subject, role, active) values ('dairyforge','box-author-service','device',true) returning tenant_id, subject, role, active");
console.log('MEMBERSHIP:', JSON.stringify(m.rows));
await pool.end();
