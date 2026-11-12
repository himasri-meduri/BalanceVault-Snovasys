import pino, { type Logger } from 'pino';

export function createLogger(level: string = 'info'): Logger {
  return pino({
    level,
    base: {
      service: 'balancevault-api',
    },
    messageKey: 'message',
    formatters: {
      level(label) {
        return { severity: label };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-csrf-token"]',
        'res.headers["set-cookie"]',
        '*.password',
        '*.passwordHash',
        '*.token',
        '*.tokenHash',
        '*.sessionSecret',
        '*.SESSION_SECRET',
        '*.ADMIN_BOOTSTRAP_SECRET',
        '*.DATABASE_URL',
        '*.DIRECT_URL',
        '*.REDIS_URL',
      ],
      censor: '[REDACTED]',
    },
  });
}
