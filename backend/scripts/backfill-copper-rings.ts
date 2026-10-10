import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { User } from '../src/auth/user.entity';
import { CopperRingBackfillService } from '../src/ring/copper-ring-backfill.service';
import { CopperRingEntitlementService } from '../src/ring/copper-ring-entitlement.service';
import { CopperRingRandomService } from '../src/ring/copper-ring-random.service';
import { CopperRingRepository } from '../src/ring/copper-ring.repository';
import { EquippedRing } from '../src/ring/equipped-ring.entity';
import { GameRing } from '../src/ring/game-ring.entity';
import { RingEvent } from '../src/ring/ring-event.entity';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const batchArgument = [...args].find((value) => value.startsWith('--batch-size='));
const confirmationArgument = [...args].find((value) => value.startsWith('--confirm-database='));
const batchSize = Number(batchArgument?.split('=', 2)[1] ?? '100');
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));

if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
  throw new Error('--batch-size must be an integer from 1 to 1000');
}
if (apply && confirmationArgument?.split('=', 2)[1] !== databaseName) {
  throw new Error(`Apply mode requires --confirm-database=${databaseName}`);
}

const dataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  synchronize: false,
  entities: [User, GameRing, EquippedRing, RingEvent],
});

async function main() {
  await dataSource.initialize();
  try {
    const entitlement = new CopperRingEntitlementService(
      new CopperRingRepository(dataSource),
      new CopperRingRandomService(),
    );
    const backfill = new CopperRingBackfillService(dataSource, entitlement);
    const summary = await backfill.summarize();

    if (!apply) {
      console.log(JSON.stringify({
        mode: 'dry-run',
        database: databaseName,
        ...summary,
        next: `rerun with --apply --confirm-database=${databaseName}`,
      }, null, 2));
      return;
    }

    const result = await backfill.apply(batchSize, (checkpoint) => console.log(JSON.stringify(checkpoint)));

    console.log(JSON.stringify({
      mode: 'apply',
      database: databaseName,
      ...result,
      completed: true,
    }, null, 2));
  } finally {
    await dataSource.destroy();
  }
}

void main();
