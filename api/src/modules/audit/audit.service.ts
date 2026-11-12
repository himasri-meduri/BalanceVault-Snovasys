import type { AuditRepository, PrismaDbClient } from './audit.repository.js';
import type {
  AuditEventRecord,
  CreateAuditEventInput,
  ListAuditEventsQuery,
} from './audit.types.js';

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  recordEvent(
    input: CreateAuditEventInput,
    tx?: PrismaDbClient,
  ): Promise<AuditEventRecord> {
    return this.repository.create(input, tx);
  }

  listEvents(query: ListAuditEventsQuery) {
    return this.repository.list(query);
  }
}
