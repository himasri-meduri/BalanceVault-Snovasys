/**
 * Parses a PostgreSQL connection URL into a redacted summary without ever
 * returning or echoing passwords, tokens, or raw query secrets.
 */
export function inspectPostgresConnectionUrl(rawUrl, sourceEnvVar) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(
      `${sourceEnvVar} is not a valid PostgreSQL connection URL (credentials redacted).`,
    );
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `${sourceEnvVar} must use the postgres:// or postgresql:// protocol.`,
    );
  }

  const username = parsed.username ? decodeURIComponent(parsed.username) : '';
  const port = parsed.port || '5432';
  const database = parsed.pathname.replace(/^\//, '') || 'postgres';
  const pgBouncerParam = parsed.searchParams.get('pgbouncer')?.toLowerCase();
  const usesPgBouncerPooler = pgBouncerParam === 'true' || port === '6543';
  const isAppRuntimeUser =
    username === 'app_runtime' || username.startsWith('app_runtime.');

  return {
    sourceEnvVar,
    host: parsed.hostname || 'unknown',
    port,
    database,
    username: username || 'unknown',
    isAppRuntimeUser,
    usesPgBouncerPooler,
  };
}

/**
 * Enforces that schema migrations and operator tasks run over DIRECT_URL
 * (direct/session connection with migration privileges), never app_runtime
 * or Supabase transaction pooler port 6543 (`pgbouncer=true`).
 */
export function assertOperatorConnection(summary, hasDirectUrl, operationName) {
  if (!hasDirectUrl && summary.isAppRuntimeUser) {
    throw new Error(
      `Refusing to run ${operationName} with least-privilege runtime role "${summary.username}" via DATABASE_URL. Configure DIRECT_URL with your migration/operator connection (e.g., postgres or app_migrator on port 5432).`,
    );
  }

  if (summary.usesPgBouncerPooler) {
    throw new Error(
      `Refusing to run ${operationName} over PgBouncer / Supabase transaction pooler (port ${summary.port}). Configure DIRECT_URL on direct/session port 5432 without ?pgbouncer=true.`,
    );
  }
}
