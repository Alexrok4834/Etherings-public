import { Check, Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn, Unique } from 'typeorm';
import { RaffleConfiguration } from './raffle-configuration.entity';
import { Reward } from './reward.entity';

@Entity('raffle_configuration_rewards')
@Unique('UQ_raffle_configuration_rewards_segment', ['configurationId', 'segmentIndex'])
@Check('CHK_raffle_configuration_rewards_segment', '"segment_index" >= 0')
@Check('CHK_raffle_configuration_rewards_weight', '"weight" > 0')
@Check('CHK_raffle_configuration_rewards_snapshot', 'jsonb_typeof("reward_snapshot") = \'object\'')
export class RaffleConfigurationReward {
  @PrimaryColumn({ name: 'configuration_id', type: 'uuid' })
  configurationId!: string;

  @ManyToOne(() => RaffleConfiguration, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'configuration_id', foreignKeyConstraintName: 'FK_raffle_configuration_rewards_configuration' })
  configuration!: RaffleConfiguration;

  @PrimaryColumn({ name: 'reward_id', type: 'uuid' })
  rewardId!: string;

  @ManyToOne(() => Reward, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'reward_id', foreignKeyConstraintName: 'FK_raffle_configuration_rewards_reward' })
  reward!: Reward;

  @Column({ name: 'segment_index', type: 'smallint' })
  segmentIndex!: number;

  @Column({ type: 'integer' })
  weight!: number;

  @Column({ name: 'reward_snapshot', type: 'jsonb' })
  rewardSnapshot!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
