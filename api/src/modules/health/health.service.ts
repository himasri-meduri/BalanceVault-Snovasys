export type DependencyHealthStatus = 'ok' | 'unavailable';

export interface ReadinessResult {
  ready: boolean;
  checks: {
    database: DependencyHealthStatus;
    redis: DependencyHealthStatus;
  };
}

export interface HealthDependencies {
  checkDatabase: () => Promise<DependencyHealthStatus>;
  checkRedis: () => Promise<DependencyHealthStatus>;
}

export class HealthService {
  constructor(private readonly deps: HealthDependencies) {}

  getLiveness() {
    return {
      status: 'ok' as const,
      service: 'balancevault-api',
      timestamp: new Date().toISOString(),
    };
  }

  async getReadiness(): Promise<ReadinessResult> {
    const [database, redis] = await Promise.all([
      this.deps.checkDatabase().catch(() => 'unavailable' as const),
      this.deps.checkRedis().catch(() => 'unavailable' as const),
    ]);

    return {
      ready: database === 'ok' && redis === 'ok',
      checks: {
        database,
        redis,
      },
    };
  }
}
