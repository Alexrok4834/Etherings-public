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
import { User } from '../auth/user.entity';
import { RaffleConfiguration } from './raffle-configuration.entity';

export enum RaffleDrawOperationStatus {
  Pending = 'PENDING',
  Completed = 'COMPLETED',
}

@Entity('raffle_draw_operations')
@Index('UQ_raffle_draw_operations_owner_key', ['ownerUserId', 'idempotencyKey'], { unique: true })
@Check('CHK_raffle_draw_operations_idempotency_v4', `"idempotency_key"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`)
@Check('CHK_raffle_draw_operations_fingerprint', `"request_fingerprint" ~ '^[0-9a-f]{64}$'`)
@Check('CHK_raffle_draw_operations_contract', `"contract_version" = 'raffle-v2'`)
@Check('CHK_raffle_draw_operations_status', `"status" IN ('PENDING', 'COMPLETED')`)
@Check(
  'CHK_raffle_draw_operations_lifecycle',
  `
    ("status" = 'PENDING' AND "response_snapshot" IS NULL AND "completed_at" IS NULL)
    OR (
      "status" = 'COMPLETED'
      AND "response_snapshot" IS NOT NULL
      AND jsonb_typeof("response_snapshot") = 'object'
      AND "completed_at" IS NOT NULL
      AND "completed_at" >= "created_at"
    )
  `,
)
@Check('CHK_raffle_draw_operations_updated_at', '"updated_at" >= "created_at"')
export class RaffleDrawOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'owner_user_id', foreignKeyConstraintName: 'FK_raffle_draw_operations_owner' })
  owner!: User;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey!: string;

  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint!: string;

  @Column({ name: 'contract_version', type: 'varchar', length: 32 })
  contractVersion!: string;

  @Column({ name: 'configuration_id', type: 'uuid' })
  configurationId!: string;

  @ManyToOne(() => RaffleConfiguration, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'configuration_id', foreignKeyConstraintName: 'FK_raffle_draw_operations_configuration' })
  configuration!: RaffleConfiguration;

  @Column({ type: 'varchar', length: 16 })
  status!: RaffleDrawOperationStatus;

  @Column({ name: 'response_snapshot', type: 'jsonb', nullable: true })
  responseSnapshot!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
