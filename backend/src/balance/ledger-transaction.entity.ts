import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../auth/user.entity';

export enum LedgerTransactionType {
  WalkReward = 'WALK_REWARD',
  RaffleSpend = 'RAFFLE_SPEND',
  RaffleReward = 'RAFFLE_REWARD',
  AdminAdjustment = 'ADMIN_ADJUSTMENT',
  RaffleRefund = 'RAFFLE_REFUND',
  CopperLevelUpSpend = 'COPPER_LEVEL_UP_SPEND',
}

export enum LedgerCurrency {
  Ert = 'ERT',
  Eru = 'ERU',
}

const integerTransformer = {
  to: (value: number) => value,
  from: (value: string | number | null) => Number(value ?? 0),
};

@Entity('ledger_transactions')
@Index(['userId', 'createdAt'])
@Check('CHK_ledger_currency_purpose', `"currency" = 'ERT' OR ("type" = 'RAFFLE_REWARD' AND "amount" > 0) OR ("type" = 'COPPER_LEVEL_UP_SPEND' AND "amount" < 0)`)
@Check('CHK_ledger_eru_decimal_values', `"currency" <> 'ERU' OR ("amount" <> 0 AND "balance_after" >= 0)`)
@Index('UQ_ledger_copper_level_up_reference', ['currency', 'referenceType', 'referenceId'], {
  unique: true,
  where: `"type" = 'COPPER_LEVEL_UP_SPEND' AND "reference_id" IS NOT NULL`,
})
@Index('UQ_ledger_eru_raffle_reward_reference', ['currency', 'referenceType', 'referenceId'], {
  unique: true,
  where: `"currency" = 'ERU' AND "type" = 'RAFFLE_REWARD' AND "reference_type" = 'raffle_draw' AND "reference_id" IS NOT NULL`,
})
@Index('UQ_ledger_walk_reward_reference', ['currency', 'referenceType', 'referenceId'], {
  unique: true,
  where: `"currency" = 'ERT' AND "type" = 'WALK_REWARD' AND "reference_type" = 'walk_session' AND "reference_id" IS NOT NULL`,
})
export class LedgerTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: LedgerTransactionType })
  type!: LedgerTransactionType;

  @Column({ type: 'enum', enum: LedgerCurrency, enumName: 'ledger_currency_enum', default: LedgerCurrency.Ert })
  currency!: LedgerCurrency;

  @Column({ type: 'numeric', precision: 48, scale: 18, transformer: integerTransformer })
  amount!: number;

  @Column({ name: 'balance_after', type: 'numeric', precision: 48, scale: 18, transformer: integerTransformer })
  balanceAfter!: number;

  @Column({ name: 'reference_type', type: 'varchar', length: 64, nullable: true })
  referenceType!: string | null;

  @Column({ name: 'reference_id', type: 'varchar', length: 128, nullable: true })
  referenceId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
