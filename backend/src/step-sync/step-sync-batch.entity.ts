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
import { StepSyncInstallation } from './step-sync-installation.entity';
import { M2eDailyEconomicSnapshot } from '../m2e/m2e-daily-economic-snapshot.entity';

export enum StepSyncBatchStatus {
  Received = 'RECEIVED',
  Accepted = 'ACCEPTED',
  PartiallyAccepted = 'PARTIALLY_ACCEPTED',
  Rejected = 'REJECTED',
}

export enum StepSyncBatchSource {
  AndroidStepCounter = 'android_step_counter',
}

const integerTransformer = {
  to: (value: number | string | null) => value,
  from: (value: string | number | null) => (value === null ? null : Number(value)),
};

@Entity('step_sync_batches')
@Index('UQ_step_sync_batch_identity', ['userId', 'installationRecordId', 'batchId'], { unique: true })
@Index('UQ_step_sync_batch_sequence', ['installationRecordId', 'sequence'], { unique: true })
@Index('IDX_step_sync_batch_owner_created', ['userId', 'createdAt'])
@Index('IDX_step_sync_batch_owner_date', ['userId', 'localDate'])
@Check('CHK_step_sync_batch_sequence', '"sequence" >= 0')
@Check('CHK_step_sync_batch_claimed_steps', '"claimed_step_count" > 0')
@Check('CHK_step_sync_batch_sensor_events', '"sensor_event_count" > 0')
@Check('CHK_step_sync_batch_timezone', '"timezone_offset_minutes" BETWEEN -1080 AND 1080')
@Check('CHK_step_sync_batch_interval', '"observed_ended_at" >= "observed_started_at"')
@Check(
  'CHK_step_sync_batch_accepted_steps',
  '"accepted_step_delta" IS NULL OR ("accepted_step_delta" >= 0 AND "accepted_step_delta" <= "claimed_step_count")',
)
@Check('CHK_step_sync_batch_earned_ert', '"earned_ert_delta" IS NULL OR "earned_ert_delta" >= 0')
@Check(
  'CHK_step_sync_batch_processing_state',
  '("status" = \'RECEIVED\' AND "accepted_step_delta" IS NULL AND "earned_ert_delta" IS NULL AND "result_code" IS NULL AND "result_snapshot" IS NULL AND "processed_at" IS NULL) OR ("status" <> \'RECEIVED\' AND "accepted_step_delta" IS NOT NULL AND "earned_ert_delta" IS NOT NULL AND "result_code" IS NOT NULL AND "result_snapshot" IS NOT NULL AND "processed_at" IS NOT NULL)',
)
@Check(
  'CHK_step_sync_batch_result_semantics',
  '"status" = \'RECEIVED\' OR ("status" = \'ACCEPTED\' AND "accepted_step_delta" = "claimed_step_count" AND "accounting_date" IS NOT NULL) OR ("status" = \'PARTIALLY_ACCEPTED\' AND "accepted_step_delta" > 0 AND "accepted_step_delta" < "claimed_step_count" AND "accounting_date" IS NOT NULL) OR ("status" = \'REJECTED\' AND "accepted_step_delta" = 0 AND "earned_ert_delta" = 0)',
)
export class StepSyncBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @Column({ name: 'installation_record_id', type: 'uuid' })
  installationRecordId!: string;

  @ManyToOne(() => StepSyncInstallation, { onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'installation_record_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_step_sync_batch_installation_owner',
    },
    { name: 'user_id', referencedColumnName: 'userId' },
  ])
  installation!: StepSyncInstallation;

  @Column({ name: 'batch_id', type: 'uuid' })
  batchId!: string;

  @Column({ type: 'bigint' })
  sequence!: string;

  @Column({ name: 'payload_hash', type: 'char', length: 64 })
  payloadHash!: string;

  @Column({ name: 'local_date', type: 'date' })
  localDate!: string;

  @Column({ name: 'timezone_offset_minutes', type: 'smallint' })
  timezoneOffsetMinutes!: number;

  @Column({ name: 'observed_started_at', type: 'timestamptz' })
  observedStartedAt!: Date;

  @Column({ name: 'observed_ended_at', type: 'timestamptz' })
  observedEndedAt!: Date;

  @Column({ name: 'claimed_step_count', type: 'integer' })
  claimedStepCount!: number;

  @Column({ name: 'sensor_event_count', type: 'integer' })
  sensorEventCount!: number;

  @Column({ type: 'enum', enum: StepSyncBatchSource })
  source!: StepSyncBatchSource;

  @Column({ name: 'algorithm_version', type: 'varchar', length: 64 })
  algorithmVersion!: string;

  @Column({ type: 'enum', enum: StepSyncBatchStatus, default: StepSyncBatchStatus.Received })
  status!: StepSyncBatchStatus;

  @Column({ name: 'accepted_step_delta', type: 'integer', nullable: true })
  acceptedStepDelta!: number | null;

  @Column({
    name: 'earned_ert_delta',
    type: 'numeric',
    precision: 48,
    scale: 18,
    nullable: true,
    transformer: integerTransformer,
  })
  earnedErtDelta!: number | string | null;

  @Column({ name: 'm2e_daily_snapshot_id', type: 'uuid', nullable: true })
  m2eDailySnapshotId!: string | null;

  @ManyToOne(() => M2eDailyEconomicSnapshot, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'm2e_daily_snapshot_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_step_sync_batch_m2e_snapshot_owner',
    },
    { name: 'user_id', referencedColumnName: 'userId' },
  ])
  m2eDailySnapshot!: M2eDailyEconomicSnapshot | null;

  @Column({ name: 'accounting_date', type: 'date', nullable: true })
  accountingDate!: string | null;

  @Column({ name: 'result_code', type: 'varchar', length: 128, nullable: true })
  resultCode!: string | null;

  @Column({ name: 'client_metadata', type: 'jsonb', nullable: true })
  clientMetadata!: Record<string, unknown> | null;

  @Column({ name: 'result_snapshot', type: 'jsonb', nullable: true })
  resultSnapshot!: Record<string, unknown> | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
