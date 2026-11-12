import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { createPrismaClient } from '../config/prisma.js';
import { PrismaBootstrapRepository } from '../modules/bootstrap/bootstrap.repository.js';
import {
  resolveOperatorDatabaseUrl,
  runFirstAdminBootstrap,
} from '../modules/bootstrap/bootstrap.service.js';

function loadBootstrapDotenv() {
  const workspaceRootEnv = resolve(import.meta.dirname, '../../../../.env');
  const cwdEnv = resolve(process.cwd(), '.env');

  if (existsSync(workspaceRootEnv)) {
    dotenv.config({ path: workspaceRootEnv });
  } else if (existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  }
}

function readCliArg(flag: string): string | undefined {
  const eqArg = process.argv.find((arg) => arg.startsWith(`${flag}=`));
  if (eqArg) {
    return eqArg.slice(flag.length + 1);
  }
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < process.argv.length) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main() {
  loadBootstrapDotenv();

  const operatorConnection = resolveOperatorDatabaseUrl({
    DIRECT_URL: process.env.DIRECT_URL,
    DATABASE_URL: process.env.DATABASE_URL,
  });

  if (operatorConnection.sourceEnvVar !== 'DIRECT_URL') {
    console.warn(
      `Warning: DIRECT_URL is not set; using DATABASE_URL (${operatorConnection.username}). Configure DIRECT_URL for explicit separation between operator/migration credentials and runtime credentials.`,
    );
  }

  const email = process.env.ADMIN_BOOTSTRAP_EMAIL ?? '';
  const envSecret = process.env.ADMIN_BOOTSTRAP_SECRET ?? '';
  const cliSecret = readCliArg('--secret');
  const bootstrapSecret = cliSecret ?? envSecret;
  const expectedBootstrapSecret = cliSecret && envSecret ? envSecret : undefined;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD ?? '';
  const fullName = process.env.ADMIN_BOOTSTRAP_NAME || 'BalanceVault Super Admin';

  const prisma = createPrismaClient(operatorConnection.url);
  const repository = new PrismaBootstrapRepository(prisma);

  try {
    const result = await runFirstAdminBootstrap(repository, {
      email,
      fullName,
      bootstrapSecret,
      expectedBootstrapSecret,
      password,
    });

    console.log(
      JSON.stringify(
        {
          status: result.status,
          adminId: result.adminUser.id,
          email: result.adminUser.email,
          role: result.adminUser.role,
          auditEventId: result.auditEventId,
          connectionTarget: {
            sourceEnvVar: operatorConnection.sourceEnvVar,
            host: operatorConnection.host,
            port: operatorConnection.port,
            database: operatorConnection.database,
            username: operatorConnection.username,
          },
          dbRoleSummary: result.dbRoleSummary,
          nextStep:
            'Remove ADMIN_BOOTSTRAP_SECRET and ADMIN_BOOTSTRAP_PASSWORD from environment after verifying login.',
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(
    'Bootstrap failed:',
    err instanceof Error ? err.message : 'Unknown bootstrap error',
  );
  process.exit(1);
});
