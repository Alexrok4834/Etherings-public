import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../auth/user.entity';
import { RafflePool } from './raffle-pool.entity';
import { Reward } from './reward.entity';

const integerTransformer = {
  to: (value: number) => value,
  from: (value: string | number | null) => Number(value ?? 0),
};

const numberTransformer = {
  to: (value: number) => value,
  from: (value: string | number | null) => Number(value ?? 0),
};

@Entity('raffle_draws')
@Index(['userId', 'createdAt'])
export class RaffleDraw {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'pool_id', type: 'uuid' })
  poolId!: string;

  @ManyToOne(() => RafflePool, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'pool_id' })
  pool!: RafflePool;

  @Column({ name: 'reward_id', type: 'uuid' })
  rewardId!: string;

  @ManyToOne(() => Reward, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'reward_id' })
  reward!: Reward;

  @Column({ name: 'cost_ert', type: 'numeric', precision: 24, scale: 0, transformer: integerTransformer })
  costErt!: number;

  @Column({ name: 'random_roll', type: 'numeric', precision: 18, scale: 12, transformer: numberTransformer })
  randomRoll!: number;

  @Column({ name: 'weights_snapshot', type: 'jsonb' })
  weightsSnapshot!: Record<string, unknown>;

  @Column({ name: 'reward_snapshot', type: 'jsonb' })
  rewardSnapshot!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}