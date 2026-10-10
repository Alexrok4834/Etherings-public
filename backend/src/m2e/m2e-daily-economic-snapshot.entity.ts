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
import { GameRing } from '../ring/game-ring.entity';
import {
  M2E_BALANCE_CONFIG_VERSION,
  M2E_EARNING_RULES_VERSION,
} from './m2e-balance-config.service';

const decimalStringTransformer = {
  to: (value: string) => value,
  from: (value: string) => value,
};

@Entity('m2e_daily_economic_snapshots')
@Index('UQ_m2e_daily_snapshot_owner_date', ['userId', 'accountingDate'], { unique: true })
@Index('UQ_m2e_daily_snapshot_id_owner', ['id', 'userId'], { unique: true })
@Check('CHK_m2e_daily_snapshot_ring_count', '"ring_count" > 0')
@Check('CHK_m2e_daily_snapshot_step_cap', '"step_cap" > 0')
@Check('CHK_m2e_daily_snapshot_base_steps', '"base_steps" > 0')
@Check('CHK_m2e_daily_snapshot_extra_steps', '"extra_steps_per_ring" > 0')
@Check('CHK_m2e_daily_snapshot_base_rate', '"base_ert_per_1000_steps" >= 0')
@Check('CHK_m2e_daily_snapshot_comfort_curve', '"comfort_curve_k" > 0')
@Check('CHK_m2e_daily_snapshot_comfort', '"selected_ring_comfort" >= 0')
@Check('CHK_m2e_daily_snapshot_rules', `"rules_version" = '${M2E_EARNING_RULES_VERSION}'`)
@Check(
  'CHK_m2e_daily_snapshot_balance_config',
  `"balance_config_version" = '${M2E_BALANCE_CONFIG_VERSION}'`,
)
export class M2eDailyEconomicSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_m2e_daily_snapshot_user' })
  user!: User;

  @Column({ name: 'accounting_date', type: 'date' })
  accountingDate!: string;

  @Column({ name: 'selected_ring_id', type: 'uuid' })
  selectedRingId!: string;

  @ManyToOne(() => GameRing, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'selected_ring_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_m2e_daily_snapshot_ring_owner',
    },
    { name: 'user_id', referencedColumnName: 'ownerUserId' },
  ])
  selectedRing!: GameRing;

  @Column({ name: 'ring_count', type: 'integer' })
  ringCount!: number;

  @Column({ name: 'selected_ring_comfort', type: 'integer' })
  selectedRingComfort!: number;

  @Column({ name: 'step_cap', type: 'integer' })
  stepCap!: number;

  @Column({ name: 'rules_version', type: 'varchar', length: 64 })
  rulesVersion!: typeof M2E_EARNING_RULES_VERSION;

  @Column({ name: 'balance_config_version', type: 'varchar', length: 64 })
  balanceConfigVersion!: typeof M2E_BALANCE_CONFIG_VERSION;

  @Column({ name: 'base_steps', type: 'integer' })
  baseSteps!: number;

  @Column({ name: 'extra_steps_per_ring', type: 'integer' })
  extraStepsPerRing!: number;

  @Column({
    name: 'base_ert_per_1000_steps',
    type: 'numeric',
    precision: 48,
    scale: 18,
    transformer: decimalStringTransformer,
  })
  baseErtPer1000Steps!: string;

  @Column({ name: 'comfort_curve_k', type: 'integer' })
  comfortCurveK!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
