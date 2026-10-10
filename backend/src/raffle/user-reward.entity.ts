import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../auth/user.entity';
import { RaffleDraw } from './raffle-draw.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { Reward, RewardType } from './reward.entity';

const integerTransformer = {
  to: (value: number | null) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

const exactDecimalTransformer = {
  to: (value: string | null) => value,
  from: (value: string | number | null) => (value === null ? null : String(value)),
};

@Entity('user_rewards')
@Index(['userId', 'createdAt'])
@Check('CHK_user_rewards_eru_amount_exact', `"type" <> 'ERU' OR ("amount_exact" IS NOT NULL AND "amount_exact" > 0)`)
@Check('CHK_user_rewards_eru_balance_after', `"eru_balance_after" IS NULL OR "eru_balance_after" >= 0`)
@Check(
  'CHK_user_rewards_source',
  `("raffle_draw_id" IS NOT NULL)::integer + ("raffle_draw_result_v2_id" IS NOT NULL)::integer = 1`,
)
@Check(
  'CHK_user_rewards_copper_ring_shape',
  `"type" <> 'COPPER_RING' OR ("amount" IS NULL AND "amount_exact" IS NULL AND "eru_balance_after" IS NULL)`,
)
@Index('UQ_user_rewards_raffle_draw_result_v2', ['raffleDrawResultV2Id'], {
  unique: true,
  where: '"raffle_draw_result_v2_id" IS NOT NULL',
})
export class UserReward {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'reward_id', type: 'uuid' })
  rewardId!: string;

  @ManyToOne(() => Reward, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reward_id' })
  reward!: Reward;

  @Column({ name: 'raffle_draw_id', type: 'uuid', nullable: true })
  raffleDrawId!: string | null;

  @ManyToOne(() => RaffleDraw, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'raffle_draw_id' })
  raffleDraw!: RaffleDraw | null;

  @Column({ name: 'raffle_draw_result_v2_id', type: 'uuid', nullable: true })
  raffleDrawResultV2Id!: string | null;

  @ManyToOne(() => RaffleDrawResultV2, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION', nullable: true })
  @JoinColumn([
    {
      name: 'raffle_draw_result_v2_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_user_rewards_raffle_draw_result_v2_owner_reward',
    },
    { name: 'user_id', referencedColumnName: 'ownerUserId' },
    { name: 'reward_id', referencedColumnName: 'selectedRewardId' },
  ])
  raffleDrawResultV2!: RaffleDrawResultV2 | null;

  @Column({ type: 'varchar', length: 128 })
  title!: string;

  @Column({ type: 'enum', enum: RewardType })
  type!: RewardType;

  @Column({ type: 'numeric', precision: 24, scale: 0, nullable: true, transformer: integerTransformer })
  amount!: number | null;

  @Column({ name: 'amount_exact', type: 'numeric', precision: 48, scale: 18, nullable: true, transformer: exactDecimalTransformer })
  amountExactValue!: string | null;

  @Column({ name: 'eru_balance_after', type: 'numeric', precision: 48, scale: 18, nullable: true, transformer: exactDecimalTransformer })
  eruBalanceAfterExact!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
