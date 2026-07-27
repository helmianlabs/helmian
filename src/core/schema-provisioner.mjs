import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { assertExpectedNeonEndpoint } from './database-target.mjs';

export async function provisionSchema(databaseUrl, expectedEndpointId, sqlDirectory) {
  // Validate and parse the endpoint using the existing helper
  const target = assertExpectedNeonEndpoint(databaseUrl, expectedEndpointId);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  
  try {
    const files = await fs.readdir(sqlDirectory);
    const sqlFiles = files.filter(f => f.endsWith('.sql')).sort();
    
    let count = 0;
    for (const file of sqlFiles) {
      const filePath = path.join(sqlDirectory, file);
      const sql = await fs.readFile(filePath, 'utf8');
      console.log(`Applying ${file}...`);
      await client.query(sql);
      count++;
    }
    return { success: true, count };
  } finally {
    await client.end();
  }
}

// Allow running as a script
if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1] === import.meta.filename) {
  const dbUrl = process.env.HELMION_DATABASE_URL;
  const endpointId = process.env.HELMION_ENDPOINT_ID;
  const sqlDir = process.env.HELMION_SQL_DIR || path.join(process.cwd(), 'sql');

  if (!dbUrl || !endpointId) {
    console.error("Missing HELMION_DATABASE_URL or HELMION_ENDPOINT_ID environment variables.");
    process.exit(1);
  }

  provisionSchema(dbUrl, endpointId, sqlDir)
    .then(result => {
      console.log(`Successfully applied ${result.count} migrations.`);
      process.exit(0);
    })
    .catch(err => {
      console.error("Schema provisioning failed:", err);
      process.exit(1);
    });
}
