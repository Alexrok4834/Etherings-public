import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../auth/user.entity';
import { GameRing } from './game-ring.entity';

@Entity('equipped_rings')
@Index('UQ_equipped_rings_ring', ['ringId'], { unique: true })
export class EquippedRing {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_equipped_rings_user' })
  user!: User;

  @Column({ name: 'ring_id', type: 'uuid' })
  ringId!: string;

  @ManyToOne(() => GameRing, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'ring_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_equipped_rings_ring_owner',
    },
    { name: 'user_id', referencedColumnName: 'ownerUserId' },
  ])
  ring!: GameRing;

  @CreateDateColumn({ name: 'equipped_at', type: 'timestamptz' })
  equippedAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
