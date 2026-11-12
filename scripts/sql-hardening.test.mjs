import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const rootDir = resolve(import.meta.dirname, '..');

function readText(relativePath) {
  return readFileSync(resolve(rootDir, relativePath), 'utf8');
}

function stripSqlComments(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function extractPrivilegeCalls(text) {
  const fnPattern = /\bhas_(?:table|sequence|function|schema)_privilege\s*\(/gi;
  const calls = [];

  for (const match of text.matchAll(fnPattern)) {
    const startIdx = match.index ?? 0;
    const argsStart = startIdx + match[0].length;
    let depth = 1;
    let inSingleQuote = false;
    let idx = argsStart;

    while (idx < text.length && depth > 0) {
      const ch = text[idx];
      if (ch === "'") {
        if (text[idx + 1] === "'") {
          idx += 2;
          continue;
        }
        inSingleQuote = !inSingleQuote;
      } else if (!inSingleQuote) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      idx += 1;
    }

    calls.push({
      fullCall: text.slice(startIdx, idx),
      argsText: text.slice(argsStart, Math.max(argsStart, idx - 1)),
    });
  }

  return calls;
}

test('SQL and TypeScript catalog queries never pass pseudo-role public or comma-separated privileges', () => {
  const filesToCheck = [
    'prisma/sql/00_inspect_roles.sql',
    'prisma/sql/01_setup_runtime_role.sql',
    'prisma/sql/02_verify_hardening.sql',
    'scripts/inspect-db-roles.mjs',
    'apps/api/src/modules/bootstrap/bootstrap.repository.ts',
  ];

  for (const file of filesToCheck) {
    const content = readText(file);
    const calls = extractPrivilegeCalls(content);

    for (const { fullCall, argsText } of calls) {
      // 1st argument must never be the literal 'public' as though PUBLIC were a regular role
      assert.equal(
        /^\s*'public'\s*,/i.test(argsText),
        false,
        `${file} must not pass 'public' as a role to has_*_privilege: ${fullCall}`,
      );

      // Privilege argument (last string literal) must never contain comma-separated privilege lists
      const quotedArgs = [...argsText.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      if (quotedArgs.length > 0) {
        const lastStringArg = quotedArgs[quotedArgs.length - 1] ?? '';
        assert.equal(
          lastStringArg.includes(','),
          false,
          `${file} must check individual privileges instead of comma-separated '${lastStringArg}': ${fullCall}`,
        );
      }
    }
  }
});

test('00_inspect_roles.sql guards pre-hardening pg_has_role lookups and inspects PUBLIC via aclexplode', () => {
  const sql = stripSqlComments(readText('prisma/sql/00_inspect_roles.sql'));

  assert.match(
    sql,
    /CASE WHEN NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'\)/i,
  );
  assert.match(sql, /aclexplode\(COALESCE\(/i);
  assert.match(sql, /pg_has_role\('app_runtime',\s*r\.oid,\s*'MEMBER'\)/i);
  assert.match(sql, /pg_has_role\('app_runtime',\s*r\.oid,\s*'USAGE'\)/i);
});

test('01_setup_runtime_role.sql is atomic, passwordless, and preserves least-privilege guarantees', () => {
  const raw = readText('prisma/sql/01_setup_runtime_role.sql');
  const sql = stripSqlComments(raw);

  assert.match(sql, /^\s*BEGIN\s*;/);
  assert.match(sql, /COMMIT\s*;\s*$/);
  assert.equal(/CHANGE_ME|WITH\s+(?:ENCRYPTED\s+)?PASSWORD/i.test(sql), false);

  assert.match(sql, /NOINHERIT/);
  assert.match(sql, /NOSUPERUSER/);
  assert.match(sql, /NOCREATEDB/);
  assert.match(sql, /NOCREATEROLE/);
  assert.match(sql, /NOREPLICATION/);
  assert.match(sql, /pg_auth_members/);
  assert.match(sql, /residual_roles/i);
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO app_runtime/i);

  assert.match(
    sql,
    /REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public\s+FROM\s+PUBLIC,\s*app_runtime/i,
  );
  assert.match(
    sql,
    /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.prevent_append_only_mutation\(\)\s+FROM\s+PUBLIC,\s*app_runtime/i,
  );
  assert.match(
    sql,
    /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.verify_balanced_journal_transaction\(\)\s+FROM\s+PUBLIC,\s*app_runtime/i,
  );
  assert.match(
    sql,
    /REVOKE\s+INSERT,\s*UPDATE,\s*DELETE,\s*TRUNCATE\s+ON\s+TABLE\s+public\."SystemBootstrapState"\s+FROM\s+app_runtime,\s*PUBLIC/i,
  );
  assert.match(
    sql,
    /GRANT\s+SELECT\s+ON\s+TABLE\s+public\."SystemBootstrapState"\s+TO\s+app_runtime/i,
  );
  assert.equal(
    /GRANT[\s\S]*_prisma_migrations[\s\S]*TO\s+app_runtime/i.test(sql),
    false,
  );

  // Even count of $$ dollar-quoting delimiters
  const dollarQuotes = sql.match(/\$\$/g) ?? [];
  assert.equal(dollarQuotes.length % 2, 0);
});

test('02_verify_hardening.sql checks PUBLIC via aclexplode, membership via pg_has_role, and rolls back cleanly', () => {
  const raw = readText('prisma/sql/02_verify_hardening.sql');
  const sql = stripSqlComments(raw);

  assert.match(sql, /^\s*BEGIN\s*;/);
  assert.match(sql, /ROLLBACK\s*;\s*$/);
  assert.match(sql, /aclexplode\(COALESCE\(/i);
  assert.match(sql, /acl\.grantee\s*=\s*0/);
  assert.match(sql, /pg_has_role\('app_runtime'/);
  assert.match(sql, /USING ERRCODE = 'BV999'/);
  assert.match(sql, /WHEN SQLSTATE 'BV999'/);
  assert.match(sql, /ARRAY\['anon',\s*'authenticated'\]/);
  assert.match(sql, /SQLERRM ILIKE '%append-only%'/i);
  assert.match(sql, /SQLERRM ILIKE '%at least 2 entries%'/i);
  assert.match(sql, /SQLERRM ILIKE '%unbalanced%'/i);
  assert.match(sql, /trg_bootstrap_state_append_only/);
  assert.match(sql, /trg_verify_balanced_journal_transaction/);
  assert.match(sql, /CREATE TEMP TABLE "JournalEntry"/i);
  assert.match(sql, /pg_temp\."JournalEntry"/i);
  assert.match(sql, /INSERT INTO public\."JournalEntry"/i);
  assert.match(sql, /search_path=/i);

  const authInt = readText('apps/api/tests/integration/auth.integration.test.ts');
  assert.match(authInt, /CREATE TEMP TABLE "JournalEntry"/);
  assert.match(authInt, /INSERT INTO pg_temp\."JournalEntry"/);
  assert.match(authInt, /INSERT INTO public\."JournalEntry"/);

  const dollarQuotes = sql.match(/\$\$/g) ?? [];
  assert.equal(dollarQuotes.length % 2, 0);
});

test('new migration hardens verify_balanced_journal_transaction() without rewriting init migration, privileges, ownership, or trigger', () => {
  const initSql = stripSqlComments(
    readText('prisma/migrations/20261111000000_init/migration.sql'),
  );
  assert.match(initSql, /CREATE OR REPLACE FUNCTION verify_balanced_journal_transaction\(\)/);
  assert.match(initSql, /CREATE CONSTRAINT TRIGGER trg_verify_balanced_journal_transaction/);

  const raw = readText(
    'prisma/migrations/20261111181000_harden_journal_balance_trigger_search_path/migration.sql',
  );
  const sql = stripSqlComments(raw);

  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.verify_balanced_journal_transaction\(\)/i,
  );
  assert.match(sql, /RETURNS TRIGGER/i);
  assert.match(sql, /LANGUAGE plpgsql/i);
  assert.match(sql, /SECURITY INVOKER/i);
  assert.equal(/SECURITY DEFINER/i.test(sql), false);
  assert.match(sql, /SET search_path\s*=\s*pg_catalog,\s*public/i);

  // Must qualify public."JournalEntry" and leave no unqualified FROM "JournalEntry"
  assert.match(sql, /FROM public\."JournalEntry"/);
  assert.equal(/FROM\s+"JournalEntry"/i.test(sql), false);

  // Preserve exact balance checks and exception messages
  assert.match(sql, /IF entry_count < 2 THEN/);
  assert.match(
    sql,
    /RAISE EXCEPTION 'JournalTransaction % must contain at least 2 entries \(found %\)', NEW\."transactionId", entry_count;/,
  );
  assert.match(sql, /IF total_credit <> total_debit THEN/);
  assert.match(
    sql,
    /RAISE EXCEPTION 'JournalTransaction % is unbalanced: total_credit=% total_debit=%', NEW\."transactionId", total_credit, total_debit;/,
  );

  // Must not grant privileges, alter ownership, or drop/recreate/alter triggers
  assert.equal(/\bGRANT\b/i.test(sql), false);
  assert.equal(/\bOWNER\s+TO\b/i.test(sql), false);
  assert.equal(/\b(?:DROP|CREATE|ALTER)\s+(?:CONSTRAINT\s+)?TRIGGER\b/i.test(sql), false);
  assert.equal(/\b(?:DISABLE|ENABLE)\s+TRIGGER\b/i.test(sql), false);

  const dollarQuotes = sql.match(/\$\$/g) ?? [];
  assert.equal(dollarQuotes.length % 2, 0);
});
