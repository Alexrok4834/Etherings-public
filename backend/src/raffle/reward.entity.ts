import { Check, Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum RewardType {
  Ert = 'ERT',
  Eru = 'ERU',
  CopperRing = 'COPPER_RING',
  Badge = 'BADGE',
  Item = 'ITEM',
  NftPlaceholder = 'NFT_PLACEHOLDER',
}

const integerTransformer = {
  to: (value: number | null) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

const exactDecimalTransformer = {
  to: (value: string | null) => value,
  from: (value: string | number | null) => (value === null ? null : String(value)),
};

@Entity('rewards')
@Check('CHK_rewards_eru_amount_exact', `"type" <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0)`)
@Check(
  'CHK_rewards_copper_ring_shape',
  `"type" <> 'COPPER_RING' OR ("amount" IS NULL AND "amount_exact" IS NULL AND "stock_total" IS NULL AND "stock_remaining" IS NULL)`,
)
export class Reward {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 128 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'enum', enum: RewardType })
  type!: RewardType;

  @Column({ type: 'numeric', precision: 24, scale: 0, nullable: true, transformer: integerTransformer })
  amount!: number | null;

  @Column({ name: 'amount_exact', type: 'numeric', precision: 48, scale: 18, nullable: true, transformer: exactDecimalTransformer })
  amountExactValue!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ name: 'image_url', type: 'varchar', length: 512, nullable: true })
  imageUrl!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'stock_total', type: 'integer', nullable: true })
  stockTotal!: number | null;

  @Column({ name: 'stock_remaining', type: 'integer', nullable: true })
  stockRemaining!: number | null;

  @Column({ name: 'per_user_limit', type: 'integer', nullable: true })
  perUserLimit!: number | null;

  @Column({ name: 'daily_global_limit', type: 'integer', nullable: true })
  dailyGlobalLimit!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
