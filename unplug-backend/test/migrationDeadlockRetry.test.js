'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  RETRYABLE_MIGRATION_CODES,
  runWithMigrationRetry,
} = require('../db/migrationRetry');

test('migration retry policy is limited to PostgreSQL concurrency errors', () => {
  assert.deepEqual([...RETRYABLE_MIGRATION_CODES].sort(), ['40001', '40P01'].sort());
});

test('deadlock retries and succeeds without hiding the original operation', async () => {
  let attempts = 0;
  const waits = [];
  const retries = [];
  const result = await runWithMigrationRetry({
    file: '204_agreement_version_approval_sync.sql',
    operation: async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('deadlock detected');
        err.code = '40P01';
        throw err;
      }
      return 'ok';
    },
    sleep: async (ms) => waits.push(ms),
    onRetry: (info) => retries.push(info),
  });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [250, 750]);
  assert.equal(retries.length, 2);
  assert.equal(retries[0].code, '40P01');
});

test('serialization failures are retryable too', async () => {
  let attempts = 0;
  const result = await runWithMigrationRetry({
    file: 'example.sql',
    operation: async () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('serialization failure');
        err.code = '40001';
        throw err;
      }
      return 42;
    },
    sleep: async () => {},
  });
  assert.equal(result, 42);
  assert.equal(attempts, 2);
});

test('real SQL errors fail immediately and are never masked by retry', async () => {
  let attempts = 0;
  const err = new Error('syntax error');
  err.code = '42601';

  await assert.rejects(
    runWithMigrationRetry({
      file: 'broken.sql',
      operation: async () => {
        attempts += 1;
        throw err;
      },
      sleep: async () => {},
    }),
    (caught) => caught === err
  );
  assert.equal(attempts, 1);
});

test('a persistent deadlock still fails after the bounded retry budget', async () => {
  let attempts = 0;
  const err = new Error('deadlock detected');
  err.code = '40P01';

  await assert.rejects(
    runWithMigrationRetry({
      file: 'locked.sql',
      operation: async () => {
        attempts += 1;
        throw err;
      },
      sleep: async () => {},
    }),
    (caught) => caught === err
  );
  assert.equal(attempts, 4);
});

test('production migrator applies every file through the retry helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrate.js'), 'utf8');
  assert.match(src, /const \{ runWithMigrationRetry \} = require\('\.\/migrationRetry'\)/);
  assert.match(src, /operation: \(\) => pool\.query\(sql\)/);
  assert.match(src, /await applyMigration\(file, sql\)/);
  assert.doesNotMatch(src, /await pool\.query\(sql\);/);
});
