import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

const integerTransformer = {
  to: (value: number) => value,
  from: (value: string | number | null) => Number(value ?? 0),
};

@Entity('raffle_pools')
export class RafflePool {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 128 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'cost_ert', type: 'numeric', precision: 24, scale: 0, default: 0, transformer: integerTransformer })
  costErt!: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'daily_user_attempt_limit', type: 'integer', nullable: true })
  dailyUserAttemptLimit!: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}