import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../auth/user.entity';

const integerTransformer = {
  to: (value: number) => value,
  from: (value: string | number | null) => Number(value ?? 0),
};

@Entity('daily_user_stats')
@Index(['userId', 'date'], { unique: true })
export class DailyUserStats {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'date' })
  date!: string;

  @Column({ name: 'accepted_steps', type: 'integer', default: 0 })
  acceptedSteps!: number;

  @Column({ name: 'earned_ert', type: 'numeric', precision: 48, scale: 18, default: 0, transformer: integerTransformer })
  earnedErt!: number;

  @Column({ name: 'raffle_attempts', type: 'integer', default: 0 })
  raffleAttempts!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
