import { Client } from 'pg';

type DemoReward = {
  code: string;
  title: string;
  description: string;
  type: 'ERT' | 'BADGE' | 'ITEM' | 'NFT_PLACEHOLDER';
  amount: number | null;
  metadata: Record<string, unknown> | null;
  stockTotal: number | null;
  stockRemaining: number | null;
};

type DemoPoolReward = {
  rewardCode: string;
  weight: number;
};

const demoRewards: DemoReward[] = [
  {
    code: 'demo_ert_10',
    title: '10 ERT',
    description: 'Demo token reward for raffle smoke checks.',
    type: 'ERT',
    amount: 10,
    metadata: { source: 'demo_seed' },
    stockTotal: 1000,
    stockRemaining: 1000,
  },
  {
    code: 'demo_badge_common',
    title: 'Common Walker Badge',
    description: 'Demo NFT placeholder reward for collectible smoke checks.',
    type: 'NFT_PLACEHOLDER',
    amount: null,
    metadata: { rarity: 'common', source: 'demo_seed' },
    stockTotal: 1000,
    stockRemaining: 1000,
  },
  {
    code: 'demo_partner_coupon',
    title: 'Partner Coupon',
    description: 'Demo item reward that represents an off-chain partner coupon.',
    type: 'ITEM',
    amount: null,
    metadata: { kind: 'coupon', partner: 'demo_partner', source: 'demo_seed' },
    stockTotal: 50,
    stockRemaining: 50,
  },
];

const demoPool = {
  code: 'demo_daily_walk',
  title: 'Daily Walk Demo',
  description: 'Repeatable MVP demo raffle pool.',
  costErt: 5,
  dailyUserAttemptLimit: 3,
};

const demoPoolRewards: DemoPoolReward[] = [
  { rewardCode: 'demo_ert_10', weight: 60 },
  { rewardCode: 'demo_badge_common', weight: 30 },
  { rewardCode: 'demo_partner_coupon', weight: 10 },
];

function hasFlag(flag: string) {
  return process.argv.includes(flag);
}

function databaseUrl() {
  return process.env.DATABASE_URL ?? 'postgres://etherings:etherings@localhost:5432/etherings_mvp';
}

async function upsertReward(client: Client, reward: DemoReward) {
  const result = await client.query(
    `
      INSERT INTO rewards (
        code, title, description, type, amount, metadata, image_url, is_active,
        stock_total, stock_remaining, per_user_limit, daily_global_limit
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, NULL, TRUE, $7, $8, NULL, NULL)
      ON CONFLICT (code) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        type = EXCLUDED.type,
        amount = EXCLUDED.amount,
        metadata = EXCLUDED.metadata,
        image_url = EXCLUDED.image_url,
        is_active = EXCLUDED.is_active,
        stock_total = EXCLUDED.stock_total,
        stock_remaining = EXCLUDED.stock_remaining,
        per_user_limit = EXCLUDED.per_user_limit,
        daily_global_limit = EXCLUDED.daily_global_limit,
        updated_at = NOW()
      RETURNING id, code, title, type, amount, stock_remaining
    `,
    [
      reward.code,
      reward.title,
      reward.description,
      reward.type,
      reward.amount,
      reward.metadata === null ? null : JSON.stringify(reward.metadata),
      reward.stockTotal,
      reward.stockRemaining,
    ],
  );

  return result.rows[0] as { id: string; code: string };
}

async function upsertPool(client: Client) {
  const result = await client.query(
    `
      INSERT INTO raffle_pools (code, title, description, cost_ert, is_active, daily_user_attempt_limit)
      VALUES ($1, $2, $3, $4, TRUE, $5)
      ON CONFLICT (code) DO UPDATE SET
        title = EXCLUDED.title,
        description = EXCLUDED.description,
        cost_ert = EXCLUDED.cost_ert,
        is_active = EXCLUDED.is_active,
        daily_user_attempt_limit = EXCLUDED.daily_user_attempt_limit,
        updated_at = NOW()
      RETURNING id, code, title, cost_ert, daily_user_attempt_limit
    `,
    [demoPool.code, demoPool.title, demoPool.description, demoPool.costErt, demoPool.dailyUserAttemptLimit],
  );

  return result.rows[0] as { id: string; code: string };
}

async function upsertPoolReward(client: Client, poolId: string, rewardId: string, weight: number) {
  const result = await client.query(
    `
      INSERT INTO raffle_pool_rewards (pool_id, reward_id, weight, is_active, starts_at, ends_at)
      VALUES ($1, $2, $3, TRUE, NULL, NULL)
      ON CONFLICT (pool_id, reward_id) DO UPDATE SET
        weight = EXCLUDED.weight,
        is_active = EXCLUDED.is_active,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        updated_at = NOW()
      RETURNING id, pool_id, reward_id, weight, is_active
    `,
    [poolId, rewardId, weight],
  );

  return result.rows[0];
}

function printPlan() {
  console.log(JSON.stringify({
    dryRun: true,
    databaseUrl: databaseUrl().replace(/:\/\/([^:]+):([^@]+)@/, '://$1:<redacted>@'),
    rewards: demoRewards,
    pool: demoPool,
    poolRewards: demoPoolRewards,
  }, null, 2));
}

async function main() {
  if (hasFlag('--dry-run')) {
    printPlan();
    return;
  }

  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();

  try {
    await client.query('BEGIN');

    const rewardsByCode = new Map<string, { id: string; code: string }>();
    for (const reward of demoRewards) {
      const saved = await upsertReward(client, reward);
      rewardsByCode.set(saved.code, saved);
    }

    const pool = await upsertPool(client);
    const links = [];
    for (const poolReward of demoPoolRewards) {
      const reward = rewardsByCode.get(poolReward.rewardCode);
      if (!reward) throw new Error(`Missing seeded reward ${poolReward.rewardCode}`);
      links.push(await upsertPoolReward(client, pool.id, reward.id, poolReward.weight));
    }

    await client.query('COMMIT');

    console.log(JSON.stringify({
      status: 'ok',
      pool,
      rewards: Array.from(rewardsByCode.values()),
      poolRewards: links.map((link) => ({
        id: link.id,
        rewardId: link.reward_id,
        weight: Number(link.weight),
        isActive: link.is_active,
      })),
      expectedProbabilities: {
        demo_ert_10: 60,
        demo_badge_common: 30,
        demo_partner_coupon: 10,
      },
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});