import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertOperatorConnection,
  inspectPostgresConnectionUrl,
} from './db-connection-utils.mjs';

test('inspectPostgresConnectionUrl redacts password and detects app_runtime and pooler ports', () => {
  const secret = 'SuperSecretPgPass!88';
  const summary = inspectPostgresConnectionUrl(
    `postgresql://app_runtime.projref:${secret}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
    'DATABASE_URL',
  );

  assert.equal(summary.sourceEnvVar, 'DATABASE_URL');
  assert.equal(summary.username, 'app_runtime.projref');
  assert.equal(summary.port, '6543');
  assert.equal(summary.database, 'postgres');
  assert.equal(summary.isAppRuntimeUser, true);
  assert.equal(summary.usesPgBouncerPooler, true);
  assert.equal('password' in summary, false);
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test('assertOperatorConnection rejects app_runtime fallback, PgBouncer poolers, and malformed URLs without leaking secrets', () => {
  const secret = 'DoNotLeakThisSecret!2026';

  assert.throws(
    () =>
      inspectPostgresConnectionUrl(
        `postgresql://postgres:${secret}#[malformed@host/postgres`,
        'DIRECT_URL',
      ),
    (err) =>
      err instanceof Error &&
      /not a valid PostgreSQL connection URL/.test(err.message) &&
      !err.message.includes(secret),
  );

  const runtimeFallback = inspectPostgresConnectionUrl(
    `postgresql://app_runtime:${secret}@db.example.supabase.co:5432/postgres`,
    'DATABASE_URL',
  );

  assert.throws(
    () => assertOperatorConnection(runtimeFallback, false, 'prisma migrate deploy'),
    (err) =>
      err instanceof Error &&
      /Refusing to run prisma migrate deploy with least-privilege runtime role/.test(
        err.message,
      ) &&
      !err.message.includes(secret),
  );

  const poolerOperator = inspectPostgresConnectionUrl(
    `postgresql://postgres:${secret}@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true`,
    'DIRECT_URL',
  );

  assert.throws(
    () => assertOperatorConnection(poolerOperator, true, 'prisma migrate deploy'),
    (err) =>
      err instanceof Error &&
      /transaction pooler/.test(err.message) &&
      !err.message.includes(secret),
  );

  const validDirect = inspectPostgresConnectionUrl(
    `postgresql://postgres:${secret}@db.example.supabase.co:5432/postgres`,
    'DIRECT_URL',
  );
  assert.doesNotThrow(() =>
    assertOperatorConnection(validDirect, true, 'prisma migrate deploy'),
  );
});
