import { DataSource } from 'typeorm';
import { CopperRingEntitlementService } from './copper-ring-entitlement.service';
import { CopperIssuanceReason } from './game-ring.entity';

export type CopperBackfillSummary = {
  totalUsers: number;
  coveredUsers: number;
  missingUsers: number;
};

export type CopperBackfillResult = {
  created: number;
  existing: number;
  processed: number;
  lastUserId: string | null;
};

export class CopperRingBackfillService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly entitlement: CopperRingEntitlementService,
  ) {}

  async summarize(): Promise<CopperBackfillSummary> {
    const [{ count: totalUsers }] = await this.dataSource.query<Array<{ count: number }>>(
      'SELECT COUNT(*)::int AS count FROM "users"',
    );
    const [{ count: coveredUsers }] = await this.dataSource.query<Array<{ count: number }>>(`
      SELECT COUNT(*)::int AS count
      FROM "users" u
      WHERE EXISTS (
        SELECT 1 FROM "game_rings" r
        WHERE r."owner_user_id" = u."id" AND r."entitlement_code" = 'starter-copper-v1'
      )
    `);
    return { totalUsers, coveredUsers, missingUsers: totalUsers - coveredUsers };
  }

  async apply(
    batchSize: number,
    onCheckpoint?: (result: CopperBackfillResult) => void,
  ): Promise<CopperBackfillResult> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
      throw new Error('batchSize must be an integer from 1 to 1000');
    }

    let cursor: string | null = null;
    let created = 0;
    let existing = 0;

    while (true) {
      const users: Array<{ id: string }> = await this.dataSource.query(`
        SELECT "id" FROM "users"
        WHERE ($1::uuid IS NULL OR "id" > $1::uuid)
        ORDER BY "id" ASC
        LIMIT $2
      `, [cursor, batchSize]);
      if (users.length === 0) break;

      for (const user of users) {
        const result = await this.entitlement.ensureStarterCopper(user.id, CopperIssuanceReason.LegacyBackfill);
        if (result.created) created += 1;
        else existing += 1;
        cursor = user.id;
      }
      onCheckpoint?.({ created, existing, processed: created + existing, lastUserId: cursor });
    }

    return { created, existing, processed: created + existing, lastUserId: cursor };
  }
}
