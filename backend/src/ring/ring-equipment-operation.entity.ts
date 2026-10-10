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
import { GameRing } from './game-ring.entity';

export const RING_EQUIPMENT_CONTRACT_VERSION = 'ring-equipment-v1';

export enum RingEquipmentOperationStatus {
  Pending = 'PENDING',
  Completed = 'COMPLETED',
}

@Entity('ring_equipment_operations')
@Index('UQ_ring_equipment_operations_owner_key', ['ownerUserId', 'idempotencyKey'], { unique: true })
@Check(
  'CHK_ring_equipment_operations_idempotency_v4',
  `"idempotency_key"::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
)
@Check('CHK_ring_equipment_operations_fingerprint', `"request_fingerprint" ~ '^[0-9a-f]{64}$'`)
@Check('CHK_ring_equipment_operations_contract', `"contract_version" = '${RING_EQUIPMENT_CONTRACT_VERSION}'`)
@Check('CHK_ring_equipment_operations_status', `"status" IN ('PENDING', 'COMPLETED')`)
@Check(
  'CHK_ring_equipment_operations_lifecycle',
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
@Check('CHK_ring_equipment_operations_updated_at', `"updated_at" >= "created_at"`)
export class RingEquipmentOperation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'owner_user_id', foreignKeyConstraintName: 'FK_ring_equipment_operations_owner' })
  owner!: User;

  @Column({ name: 'target_ring_id', type: 'uuid' })
  targetRingId!: string;

  @ManyToOne(() => GameRing, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'target_ring_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_ring_equipment_operations_target_owner',
    },
    { name: 'owner_user_id', referencedColumnName: 'ownerUserId' },
  ])
  targetRing!: GameRing;

  @Column({ name: 'expected_equipped_ring_id', type: 'uuid' })
  expectedEquippedRingId!: string;

  @ManyToOne(() => GameRing, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'expected_equipped_ring_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_ring_equipment_operations_expected_owner',
    },
    { name: 'owner_user_id', referencedColumnName: 'ownerUserId' },
  ])
  expectedEquippedRing!: GameRing;

  @Column({ name: 'idempotency_key', type: 'uuid' })
  idempotencyKey!: string;

  @Column({ name: 'request_fingerprint', type: 'char', length: 64 })
  requestFingerprint!: string;

  @Column({ name: 'contract_version', type: 'varchar', length: 32 })
  contractVersion!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: RingEquipmentOperationStatus;

  @Column({ name: 'response_snapshot', type: 'jsonb', nullable: true })
  responseSnapshot!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;
}
