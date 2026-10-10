import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../auth/user.entity';
import { RaffleMachine } from './raffle-machine.entity';

export enum RaffleConfigurationStatus {
  Draft = 'DRAFT',
  Active = 'ACTIVE',
  Disabled = 'DISABLED',
}

const exactDecimalTransformer = {
  to: (value: string) => value,
  from: (value: string | number) => String(value),
};

@Entity('raffle_configurations')
@Index('UQ_raffle_configurations_active_machine', ['machineId'], {
  unique: true,
  where: '"status" = \'ACTIVE\'',
})
@Check('CHK_raffle_configurations_contract', '"contract_version" = \'raffle-v2\'')
@Check('CHK_raffle_configurations_status', '"status" IN (\'DRAFT\', \'ACTIVE\', \'DISABLED\')')
@Check('CHK_raffle_configurations_title', 'length(btrim("title")) > 0')
@Check('CHK_raffle_configurations_cost', '"cost_ert" > 0')
@Check('CHK_raffle_configurations_attempt_limit', '"daily_user_attempt_limit" > 0')
@Check(
  'CHK_raffle_configurations_lifecycle_timestamps',
  `
    ("status" = 'DRAFT' AND "activated_at" IS NULL AND "disabled_at" IS NULL)
    OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "disabled_at" IS NULL)
    OR (
      "status" = 'DISABLED'
      AND "activated_at" IS NOT NULL
      AND "disabled_at" IS NOT NULL
      AND "disabled_at" >= "activated_at"
    )
  `,
)
export class RaffleConfiguration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'machine_id', type: 'uuid' })
  machineId!: string;

  @ManyToOne(() => RaffleMachine, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'machine_id', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_raffle_configurations_machine' })
  machine!: RaffleMachine;

  @Column({ name: 'contract_version', type: 'varchar', length: 32 })
  contractVersion!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: RaffleConfigurationStatus;

  @Column({ type: 'varchar', length: 128 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    name: 'cost_ert',
    type: 'numeric',
    precision: 48,
    scale: 18,
    transformer: exactDecimalTransformer,
  })
  costErtExact!: string;

  @Column({ name: 'daily_user_attempt_limit', type: 'smallint' })
  dailyUserAttemptLimit!: number;

  @Column({ name: 'created_by_user_id', type: 'uuid' })
  createdByUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'created_by_user_id', foreignKeyConstraintName: 'FK_raffle_configurations_creator' })
  createdBy!: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  @Column({ name: 'disabled_at', type: 'timestamptz', nullable: true })
  disabledAt!: Date | null;
}
