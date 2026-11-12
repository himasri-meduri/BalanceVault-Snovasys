import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import {
  assertOperatorConnection,
  inspectPostgresConnectionUrl,
} from './db-connection-utils.mjs';

const rootDir = resolve(import.meta.dirname, '..');
const envPath = resolve(rootDir, '.env');

if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

const subcommand = process.argv[2] ?? 'status';
const allowedSubcommands = new Set(['deploy', 'status', 'dev', 'resolve']);
if (!allowedSubcommands.has(subcommand)) {
  console.error(
    `Unsupported migration subcommand "${subcommand}". Allowed: deploy, status, dev, resolve`,
  );
  process.exit(1);
}

const hasDirectUrl = Boolean(process.env.DIRECT_URL);
const migrationUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
const sourceEnvVar = hasDirectUrl ? 'DIRECT_URL' : 'DATABASE_URL';

if (!migrationUrl) {
  console.error(
    'Missing DIRECT_URL (preferred for migrations) or DATABASE_URL in environment/.env.',
  );
  process.exit(1);
}

let connectionSummary;
try {
  connectionSummary = inspectPostgresConnectionUrl(migrationUrl, sourceEnvVar);
  assertOperatorConnection(
    connectionSummary,
    hasDirectUrl,
    `prisma migrate ${subcommand}`,
  );
} catch (err) {
  console.error(
    err instanceof Error ? err.message : 'Invalid migration database configuration.',
  );
  process.exit(1);
}

if (!hasDirectUrl) {
  console.warn(
    `Warning: DIRECT_URL is not set; falling back to DATABASE_URL (${connectionSummary.username}). Configure DIRECT_URL for explicit separation between migration and runtime credentials.`,
  );
}

console.log('Running Prisma migrate with redacted target:', {
  subcommand,
  sourceEnvVar: connectionSummary.sourceEnvVar,
  host: connectionSummary.host,
  port: connectionSummary.port,
  database: connectionSummary.database,
  username: connectionSummary.username,
});

const extraArgs = process.argv.slice(3);
const prismaEntry = resolve(rootDir, 'node_modules', 'prisma', 'build', 'index.js');

const result = spawnSync(
  process.execPath,
  [prismaEntry, 'migrate', subcommand, '--schema=prisma/schema.prisma', ...extraArgs],
  {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL: migrationUrl,
    },
  },
);

process.exit(result.status ?? 1);
