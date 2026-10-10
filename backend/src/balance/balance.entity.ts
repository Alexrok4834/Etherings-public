import { Check, Column, Entity, JoinColumn, OneToOne, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../auth/user.entity';

const integerTransformer = {
  to: (value: number) => value,
  from: (value: string | number | null) => Number(value ?? 0),
};

const decimalStringTransformer = {
  to: (value: string) => value,
  from: (value: string | number | null) => String(value ?? 0),
};

@Entity('balances')
@Check('CHK_balances_eru_balance', `"eru_balance" >= 0`)
@Check('CHK_balances_lifetime_earned_eru', `"lifetime_earned_eru" >= 0`)
@Check('CHK_balances_lifetime_spent_eru', `"lifetime_spent_eru" >= 0`)
export class Balance {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ name: 'ert_balance', type: 'numeric', precision: 48, scale: 18, default: 0, transformer: integerTransformer })
  ertBalance!: number;

  @Column({ name: 'lifetime_earned_ert', type: 'numeric', precision: 48, scale: 18, default: 0, transformer: integerTransformer })
  lifetimeEarnedErt!: number;

  @Column({ name: 'lifetime_spent_ert', type: 'numeric', precision: 48, scale: 18, default: 0, transformer: integerTransformer })
  lifetimeSpentErt!: number;

  @Column({ name: 'eru_balance', type: 'numeric', precision: 48, scale: 18, default: 0, transformer: decimalStringTransformer })
  eruBalance!: string;

  @Column({ name: 'lifetime_earned_eru', type: 'numeric', precision: 48, scale: 18, default: 0, transformer: decimalStringTransformer })
  lifetimeEarnedEru!: string;

  @Column({ name: 'lifetime_spent_eru', type: 'numeric', precision: 48, scale: 18, default: 0, transformer: decimalStringTransformer })
  lifetimeSpentEru!: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
