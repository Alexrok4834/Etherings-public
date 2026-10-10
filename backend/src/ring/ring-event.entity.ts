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
import { GameRing, COPPER_RULESET_VERSION } from './game-ring.entity';

export enum RingEventType {
  StarterIssued = 'STARTER_ISSUED',
  LevelUp = 'LEVEL_UP',
  AttributePointsAllocated = 'ATTRIBUTE_POINTS_ALLOCATED',
  RaffleAwarded = 'RAFFLE_AWARDED',
  Equipped = 'EQUIPPED',
}

@Entity('ring_events')
@Index('UQ_ring_events_operation_key', ['operationKey'], { unique: true })
@Index('UQ_ring_events_starter_issued', ['ringId'], {
  unique: true,
  where: '"event_type" = \'STARTER_ISSUED\'',
})
@Index('UQ_ring_events_raffle_awarded', ['ringId'], {
  unique: true,
  where: '"event_type" = \'RAFFLE_AWARDED\'',
})
@Index('UQ_ring_events_award_identity', ['id', 'ringId', 'ownerUserId'], { unique: true })
@Index('IDX_ring_events_ring_created', ['ringId', 'createdAt'])
@Index('IDX_ring_events_owner_created', ['ownerUserId', 'createdAt'])
@Check(
  'CHK_ring_events_type',
  `"event_type" IN ('${RingEventType.StarterIssued}', '${RingEventType.LevelUp}', '${RingEventType.AttributePointsAllocated}', '${RingEventType.RaffleAwarded}', '${RingEventType.Equipped}')`,
)
@Check('CHK_ring_events_ruleset', `"ruleset_version" = '${COPPER_RULESET_VERSION}'`)
@Check('CHK_ring_events_snapshot', `jsonb_typeof("snapshot") = 'object'`)
export class RingEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ring_id', type: 'uuid' })
  ringId!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne(() => GameRing, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn([
    {
      name: 'ring_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_ring_events_ring_owner',
    },
    { name: 'owner_user_id', referencedColumnName: 'ownerUserId' },
  ])
  ring!: GameRing;

  @Column({ name: 'operation_key', type: 'varchar', length: 128 })
  operationKey!: string;

  @Column({ name: 'event_type', type: 'varchar', length: 64 })
  eventType!: RingEventType;

  @Column({ name: 'ruleset_version', type: 'varchar', length: 64 })
  rulesetVersion!: string;

  @Column({ type: 'jsonb' })
  snapshot!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
