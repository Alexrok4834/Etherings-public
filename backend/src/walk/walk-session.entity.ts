import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../auth/user.entity';

export enum WalkSessionStatus {
  Started = 'STARTED',
  Submitted = 'SUBMITTED',
  Accepted = 'ACCEPTED',
  Rejected = 'REJECTED',
}

export enum WalkSessionSource {
  TelegramAccelerometer = 'telegram_accelerometer',
  AndroidStepCounter = 'android_step_counter',
}

const integerTransformer = {
  to: (value: number | null) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

const numberTransformer = {
  to: (value: number | null) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

@Entity('walk_sessions')
@Index(['userId', 'createdAt'])
export class WalkSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ type: 'enum', enum: WalkSessionStatus, default: WalkSessionStatus.Started })
  status!: WalkSessionStatus;

  @Column({ name: 'started_at', type: 'timestamp' })
  startedAt!: Date;

  @Column({ name: 'ended_at', type: 'timestamp', nullable: true })
  endedAt!: Date | null;

  @Column({ name: 'client_step_count', type: 'integer', nullable: true })
  clientStepCount!: number | null;

  @Column({ name: 'accepted_step_count', type: 'integer', nullable: true })
  acceptedStepCount!: number | null;

  @Column({ name: 'duration_seconds', type: 'integer', nullable: true })
  durationSeconds!: number | null;

  @Column({ name: 'distance_meters', type: 'numeric', precision: 12, scale: 2, nullable: true, transformer: numberTransformer })
  distanceMeters!: number | null;

  @Column({ name: 'avg_speed_mps', type: 'numeric', precision: 8, scale: 3, nullable: true, transformer: numberTransformer })
  avgSpeedMps!: number | null;

  @Column({ type: 'enum', enum: WalkSessionSource, default: WalkSessionSource.TelegramAccelerometer })
  source!: WalkSessionSource;

  @Column({ name: 'rejection_reason', type: 'varchar', length: 128, nullable: true })
  rejectionReason!: string | null;

  @Column({ name: 'raw_summary', type: 'jsonb', nullable: true })
  rawSummary!: Record<string, unknown> | null;

  @Column({ name: 'earned_ert', type: 'numeric', precision: 48, scale: 18, default: 0, transformer: integerTransformer })
  earnedErt!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;
}
