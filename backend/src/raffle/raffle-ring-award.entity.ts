import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../auth/user.entity';
import { COPPER_RULESET_VERSION, GameRing } from '../ring/game-ring.entity';
import { RingEvent } from '../ring/ring-event.entity';
import { RaffleDrawOperation } from './raffle-draw-operation.entity';
import { RaffleDrawResultV2 } from './raffle-draw-result-v2.entity';
import { Reward } from './reward.entity';

export const RAFFLE_COPPER_FULFILLMENT_VERSION = 'raffle-copper-fulfillment-v1';

@Entity('raffle_ring_awards')
@Index('UQ_raffle_ring_awards_draw_result', ['drawResultId'], { unique: true })
@Index('UQ_raffle_ring_awards_ring', ['ringId'], { unique: true })
@Index('UQ_raffle_ring_awards_event', ['ringEventId'], { unique: true })
@Index('UQ_raffle_ring_awards_owner_day', ['ownerUserId', 'awardUtcDate'], { unique: true })
@Check('CHK_raffle_ring_awards_fulfillment_version', `"fulfillment_version" = '${RAFFLE_COPPER_FULFILLMENT_VERSION}'`)
@Check('CHK_raffle_ring_awards_ruleset_version', `"ruleset_version" = '${COPPER_RULESET_VERSION}'`)
export class RaffleRingAward {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'operation_id', type: 'uuid' })
  operationId!: string;

  @OneToOne(() => RaffleDrawOperation, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'operation_id', foreignKeyConstraintName: 'FK_raffle_ring_awards_operation' })
  operation!: RaffleDrawOperation;

  @Column({ name: 'draw_result_id', type: 'uuid' })
  drawResultId!: string;

  @ManyToOne(() => RaffleDrawResultV2, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'draw_result_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_raffle_ring_awards_result_identity',
    },
    { name: 'operation_id', referencedColumnName: 'operationId' },
    { name: 'owner_user_id', referencedColumnName: 'ownerUserId' },
    { name: 'reward_id', referencedColumnName: 'selectedRewardId' },
  ])
  drawResult!: RaffleDrawResultV2;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'owner_user_id', foreignKeyConstraintName: 'FK_raffle_ring_awards_owner' })
  owner!: User;

  @Column({ name: 'reward_id', type: 'uuid' })
  rewardId!: string;

  @ManyToOne(() => Reward, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'reward_id', foreignKeyConstraintName: 'FK_raffle_ring_awards_reward' })
  reward!: Reward;

  @Column({ name: 'ring_id', type: 'uuid' })
  ringId!: string;

  @ManyToOne(() => GameRing, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    { name: 'ring_id', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_raffle_ring_awards_ring_owner' },
    { name: 'owner_user_id', referencedColumnName: 'ownerUserId' },
  ])
  ring!: GameRing;

  @Column({ name: 'ring_event_id', type: 'uuid' })
  ringEventId!: string;

  @ManyToOne(() => RingEvent, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'ring_event_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_raffle_ring_awards_event_identity',
    },
    { name: 'ring_id', referencedColumnName: 'ringId' },
    { name: 'owner_user_id', referencedColumnName: 'ownerUserId' },
  ])
  ringEvent!: RingEvent;

  @Column({ name: 'award_utc_date', type: 'date' })
  awardUtcDate!: string;

  @Column({ name: 'fulfillment_version', type: 'varchar', length: 64 })
  fulfillmentVersion!: string;

  @Column({ name: 'ruleset_version', type: 'varchar', length: 64 })
  rulesetVersion!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
