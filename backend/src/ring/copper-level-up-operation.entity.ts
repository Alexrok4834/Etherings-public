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
import { COPPER_LEVEL_UP_V1_VERSION, COPPER_LEVEL_UP_V2_VERSION } from './copper-level-up.rules';

export enum CopperLevelUpOperationStatus {
  Pending = 'PENDING',
  Completed = 'COMPLETED',
}

@Entity('copper_level_up_operations')
@Index('UQ_copper_level_up_owner_key', ['ownerUserId', 'idempotencyKey'], { unique: true })
@Check('CHK_copper_level_up_operation_status', `"status" IN ('PENDING', 'COMPLETED')`)
@Check('CHK_copper_level_up_operation_fingerprint', `"request_fingerprint" ~ '^[0-9a-f]{64}$'`)
@Check(
  'CHK_copper_level_up_operation_rules',
  `"rules_version" IN ('${COPPER_LEVEL_UP_V1_VERSION}', '${COPPER_LEVEL_UP_V2_VERSION}')`,
)
@Check(
  'CHK_copper_level_up_operation_response',
  `("status" = 'PENDING' AND "response_snapshot" IS NULL) OR ("status" = 'COMPLETED' AND "response_snapshot" IS NOT NULL AND jsonb_typeof("response_snapshot") = 'object')`,
)
export class CopperLevelUpOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'owner_user_id', foreignKeyConstraintName: 'FK_copper_level_up_operation_owner' })
  owner!: User;

  @Column({ name: 'ring_id', type: 'uuid' })
  ringId!: string;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey!: string;

  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint!: string;

  @Column({ name: 'rules_version', type: 'varchar', length: 64 })
  rulesVersion!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: CopperLevelUpOperationStatus;

  @Column({ name: 'response_snapshot', type: 'jsonb', nullable: true })
  responseSnapshot!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
