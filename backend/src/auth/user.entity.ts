import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'telegram_id', type: 'varchar', unique: true, length: 64 })
  telegramId!: string;

  @Column({ type: 'varchar', nullable: true, length: 64 })
  username!: string | null;

  @Column({ name: 'first_name', type: 'varchar', nullable: true, length: 128 })
  firstName!: string | null;

  @Column({ name: 'last_name', type: 'varchar', nullable: true, length: 128 })
  lastName!: string | null;

  @Column({ name: 'photo_url', type: 'varchar', nullable: true, length: 512 })
  photoUrl!: string | null;

  @Column({ name: 'is_admin', type: 'boolean', default: false })
  isAdmin!: boolean;

  @Column({ name: 'last_login_at', type: 'timestamp', nullable: true })
  lastLoginAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt!: Date;
}
