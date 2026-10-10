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
import { RaffleConfiguration } from './raffle-configuration.entity';
import { RaffleDrawOperation } from './raffle-draw-operation.entity';
import { RaffleMachine } from './raffle-machine.entity';
import { Reward } from './reward.entity';

const exactDecimalTransformer = {
  to: (value: string) => value,
  from: (value: string | number) => String(value),
};

@Entity('raffle_draw_results_v2')
@Index('UQ_raffle_draw_results_v2_operation', ['operationId'], { unique: true })
@Index('UQ_raffle_draw_results_v2_owner_reward', ['id', 'ownerUserId', 'selectedRewardId'], { unique: true })
@Index('UQ_raffle_draw_results_v2_award_identity', ['id', 'operationId', 'ownerUserId', 'selectedRewardId'], {
  unique: true,
})
@Index('IDX_raffle_draw_results_v2_owner_history', ['ownerUserId', 'createdAt', 'id'])
@Check('CHK_raffle_draw_results_v2_algorithm', `"algorithm" = 'CSPRNG_UNBIASED_INT_V1'`)
@Check('CHK_raffle_draw_results_v2_ticket', '"ticket" >= 0 AND "total_weight" > 0 AND "ticket" < "total_weight"')
@Check('CHK_raffle_draw_results_v2_segment', '"selected_segment_index" >= 0')
@Check('CHK_raffle_draw_results_v2_ranges', `jsonb_typeof("ranges_snapshot") = 'object'`)
@Check('CHK_raffle_draw_results_v2_cost', '"cost_ert" > 0')
export class RaffleDrawResultV2 {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'operation_id', type: 'uuid' })
  operationId!: string;

  @OneToOne(() => RaffleDrawOperation, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'operation_id', foreignKeyConstraintName: 'FK_raffle_draw_results_v2_operation' })
  operation!: RaffleDrawOperation;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'owner_user_id', foreignKeyConstraintName: 'FK_raffle_draw_results_v2_owner' })
  owner!: User;

  @Column({ name: 'machine_id', type: 'uuid' })
  machineId!: string;

  @ManyToOne(() => RaffleMachine, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'machine_id', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_raffle_draw_results_v2_machine' })
  machine!: RaffleMachine;

  @Column({ name: 'configuration_id', type: 'uuid' })
  configurationId!: string;

  @ManyToOne(() => RaffleConfiguration, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'configuration_id', foreignKeyConstraintName: 'FK_raffle_draw_results_v2_configuration' })
  configuration!: RaffleConfiguration;

  @Column({ name: 'selected_reward_id', type: 'uuid' })
  selectedRewardId!: string;

  @ManyToOne(() => Reward, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'selected_reward_id', foreignKeyConstraintName: 'FK_raffle_draw_results_v2_reward' })
  selectedReward!: Reward;

  @Column({ name: 'selected_segment_index', type: 'smallint' })
  selectedSegmentIndex!: number;

  @Column({ type: 'varchar', length: 64 })
  algorithm!: string;

  @Column({ type: 'integer' })
  ticket!: number;

  @Column({ name: 'total_weight', type: 'integer' })
  totalWeight!: number;

  @Column({ name: 'ranges_snapshot', type: 'jsonb' })
  rangesSnapshot!: Record<string, unknown>;

  @Column({
    name: 'cost_ert',
    type: 'numeric',
    precision: 48,
    scale: 18,
    transformer: exactDecimalTransformer,
  })
  costErtExact!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
