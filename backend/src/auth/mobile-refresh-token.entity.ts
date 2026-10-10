import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StepSyncInstallation } from '../step-sync/step-sync-installation.entity';
import { User } from './user.entity';

export enum MobileRefreshTokenStatus {
  Active = 'ACTIVE',
  Rotated = 'ROTATED',
  Revoked = 'REVOKED',
}

@Entity('mobile_refresh_tokens')
@Index('UQ_mobile_refresh_token_hash', ['tokenHash'], { unique: true })
@Index('IDX_mobile_refresh_token_family', ['familyId'])
@Index('IDX_mobile_refresh_token_owner_installation', ['userId', 'installationRecordId'])
@Index('UQ_mobile_refresh_token_active_family', ['familyId'], { unique: true, where: '"status" = \'ACTIVE\'' })
@Index('UQ_mobile_refresh_token_active_installation', ['userId', 'installationRecordId'], {
  unique: true,
  where: '"status" = \'ACTIVE\'',
})
@Check('CHK_mobile_refresh_token_expiry', '"expires_at" > "created_at"')
@Check(
  'CHK_mobile_refresh_token_state',
  '("status" = \'ACTIVE\' AND "consumed_at" IS NULL AND "revoked_at" IS NULL AND "replaced_by_token_id" IS NULL) OR ("status" = \'ROTATED\' AND "consumed_at" IS NOT NULL AND "revoked_at" IS NULL AND "replaced_by_token_id" IS NOT NULL) OR ("status" = \'REVOKED\' AND "revoked_at" IS NOT NULL)',
)
export class MobileRefreshToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'family_id', type: 'uuid' })
  familyId!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_mobile_refresh_tokens_user' })
  user!: User;

  @Column({ name: 'installation_record_id', type: 'uuid' })
  installationRecordId!: string;

  @ManyToOne(() => StepSyncInstallation, { onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'installation_record_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_mobile_refresh_token_installation_owner',
    },
    { name: 'user_id', referencedColumnName: 'userId' },
  ])
  installation!: StepSyncInstallation;

  @Column({ name: 'token_hash', type: 'char', length: 64 })
  tokenHash!: string;

  @Column({ name: 'parent_token_id', type: 'uuid', nullable: true })
  parentTokenId!: string | null;

  @Column({ name: 'replaced_by_token_id', type: 'uuid', nullable: true })
  replacedByTokenId!: string | null;

  @Column({ type: 'enum', enum: MobileRefreshTokenStatus, default: MobileRefreshTokenStatus.Active })
  status!: MobileRefreshTokenStatus;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ name: 'revocation_reason', type: 'varchar', length: 64, nullable: true })
  revocationReason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
