import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { RafflePool } from './raffle-pool.entity';
import { Reward } from './reward.entity';

@Entity('raffle_pool_rewards')
@Index(['poolId', 'rewardId'], { unique: true })
export class RafflePoolReward {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'pool_id', type: 'uuid' })
  poolId!: string;

  @ManyToOne(() => RafflePool, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'pool_id' })
  pool!: RafflePool;

  @Column({ name: 'reward_id', type: 'uuid' })
  rewardId!: string;

  @ManyToOne(() => Reward, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reward_id' })
  reward!: Reward;

  @Column({ type: 'integer' })
  weight!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'starts_at', type: 'timestamp', nullable: true })
  startsAt!: Date | null;

  @Column({ name: 'ends_at', type: 'timestamp', nullable: true })
  endsAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}