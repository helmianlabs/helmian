import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { HERALD_ACCOUNT_CONTROL_SQL } from '../../../src/cloud/herald-account-control-sql.mjs';

test('embedded Herald account-control SQL is byte-identical to the repo SQL file', async () => {
  const sqlBytes = await readFile(new URL('../../../sql/herald-account-control.sql', import.meta.url));
  assert.deepEqual(Buffer.from(HERALD_ACCOUNT_CONTROL_SQL, 'utf8'), sqlBytes);
});
