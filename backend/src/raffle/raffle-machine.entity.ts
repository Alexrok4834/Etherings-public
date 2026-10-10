import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('raffle_machines')
@Index('UQ_raffle_machines_id', ['id'], { unique: true })
@Index('UQ_raffle_machines_code', ['code'], { unique: true })
@Check('CHK_raffle_machines_singleton', '"singleton_key" = 1')
@Check('CHK_raffle_machines_code', 'length(btrim("code")) > 0')
@Check('CHK_raffle_machines_availability', '("is_available" AND "paused_at" IS NULL) OR (NOT "is_available" AND "paused_at" IS NOT NULL)')
export class RaffleMachine {
  @PrimaryColumn({ name: 'singleton_key', type: 'smallint', default: 1 })
  singletonKey!: number;

  @Column({ type: 'uuid', default: () => 'uuid_generate_v4()' })
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  code!: string;

  @Column({ name: 'is_available', type: 'boolean', default: true })
  isAvailable!: boolean;

  @Column({ name: 'paused_at', type: 'timestamptz', nullable: true })
  pausedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
