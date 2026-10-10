import {
  Column,
  Check,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../auth/user.entity';

export enum StepSyncInstallationStatus {
  Active = 'ACTIVE',
  Revoked = 'REVOKED',
}

@Entity('step_sync_installations')
@Index('UQ_step_sync_installation_owner_client', ['userId', 'installationId'], { unique: true })
@Index('UQ_step_sync_installation_id_owner', ['id', 'userId'], { unique: true })
@Index('IDX_step_sync_installation_owner_status', ['userId', 'status'])
@Check(
  'CHK_step_sync_installation_status',
  '("status" = \'ACTIVE\' AND "revoked_at" IS NULL) OR ("status" = \'REVOKED\' AND "revoked_at" IS NOT NULL)',
)
export class StepSyncInstallation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_step_sync_installations_user' })
  user!: User;

  @Column({ name: 'installation_id', type: 'uuid' })
  installationId!: string;

  @Column({ type: 'enum', enum: StepSyncInstallationStatus, default: StepSyncInstallationStatus.Active })
  status!: StepSyncInstallationStatus;

  @Column({ name: 'last_seen_at', type: 'timestamptz', nullable: true })
  lastSeenAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
