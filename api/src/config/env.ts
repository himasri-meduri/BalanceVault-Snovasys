import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const booleanStringSchema = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((val) => (typeof val === 'boolean' ? val : val === 'true'));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    APP_ORIGIN: z.string().url('APP_ORIGIN must be a valid URL'),
    API_PUBLIC_URL: z.string().url('API_PUBLIC_URL must be a valid URL'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
    SESSION_SECRET: z
      .string()
      .min(32, 'SESSION_SECRET must be at least 32 characters'),
    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
    COOKIE_SECURE: booleanStringSchema.optional(),
    COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((data, ctx) => {
    const cookieSecure = data.COOKIE_SECURE ?? data.NODE_ENV === 'production';

    if (data.COOKIE_SAME_SITE === 'none' && !cookieSecure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true when COOKIE_SAME_SITE is "none"',
      });
    }

    if (data.NODE_ENV === 'production' && !cookieSecure) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true in production',
      });
    }

    if (
      data.SESSION_SECRET.includes('REPLACE_WITH') ||
      data.SESSION_SECRET.includes('CHANGE_ME')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_SECRET'],
        message: 'SESSION_SECRET must not use an example placeholder value',
      });
    }
  });

export type AppEnv = Omit<z.infer<typeof envSchema>, 'COOKIE_SECURE'> & {
  COOKIE_SECURE: boolean;
};

export function parseEnv(rawEnv: Record<string, string | undefined>): AppEnv {
  const parsed = envSchema.safeParse(rawEnv);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }

  const cookieSecure =
    parsed.data.COOKIE_SECURE ?? parsed.data.NODE_ENV === 'production';

  return {
    ...parsed.data,
    COOKIE_SECURE: cookieSecure,
  };
}

export function loadEnvFromDiskAndProcess(): AppEnv {
  const workspaceRootEnv = resolve(import.meta.dirname, '../../../../.env');
  const cwdEnv = resolve(process.cwd(), '.env');

  if (existsSync(workspaceRootEnv)) {
    dotenv.config({ path: workspaceRootEnv });
  } else if (existsSync(cwdEnv)) {
    dotenv.config({ path: cwdEnv });
  }

  return parseEnv(process.env);
}

export function getRedactedEnvSummary(env: AppEnv) {
  return {
    nodeEnv: env.NODE_ENV,
    port: env.PORT,
    appOrigin: env.APP_ORIGIN,
    apiPublicUrl: env.API_PUBLIC_URL,
    cookieSecure: env.COOKIE_SECURE,
    cookieSameSite: env.COOKIE_SAME_SITE,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    sessionIdleMinutes: env.SESSION_IDLE_MINUTES,
    databaseConfigured: Boolean(env.DATABASE_URL),
    redisConfigured: Boolean(env.REDIS_URL),
  };
}
