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

export enum GameRingKind {
  Copper = 'COPPER',
}

export enum GameRingStatus {
  Active = 'ACTIVE',
}

export enum CopperIssuanceReason {
  Registration = 'REGISTRATION',
  LegacyBackfill = 'LEGACY_BACKFILL',
  LazyEnsure = 'LAZY_ENSURE',
  Raffle = 'RAFFLE',
}

export enum CopperVisualVariant {
  PlainPolished = 'copper_plain_polished',
  RuneRough = 'copper_rune_rough',
  Twisted = 'copper_twisted',
  Geometric = 'copper_geometric',
  Milgrain = 'copper_milgrain',
  Leaves = 'copper_leaves',
  Celtic = 'copper_celtic',
  Filigree = 'copper_filigree',
  Signet = 'copper_signet',
}

export const COPPER_ENTITLEMENT_CODE = 'starter-copper-v1';
export const RAFFLE_COPPER_ENTITLEMENT_PREFIX = 'raffle-copper-v1:';
export const COPPER_RULESET_VERSION = 'copper-rules-v1';
export const COPPER_GENERATION_VERSION = 'copper-generation-v1';
export const COPPER_VISUAL_SET_VERSION = 'copper-visual-v1';

const sqlStringList = (values: string[]) => values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ');

@Entity('game_rings')
@Index('UQ_game_rings_owner_entitlement', ['ownerUserId', 'entitlementCode'], { unique: true })
@Index('UQ_game_rings_id_owner', ['id', 'ownerUserId'], { unique: true })
@Index('IDX_game_rings_owner_created', ['ownerUserId', 'createdAt'])
@Check(
  'CHK_game_rings_entitlement',
  `"entitlement_code" = '${COPPER_ENTITLEMENT_CODE}' OR "entitlement_code" ~ '^${RAFFLE_COPPER_ENTITLEMENT_PREFIX}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'`,
)
@Check('CHK_game_rings_kind', `"ring_kind" = '${GameRingKind.Copper}'`)
@Check('CHK_game_rings_status', `"status" = '${GameRingStatus.Active}'`)
@Check('CHK_game_rings_level', '"level" BETWEEN 1 AND 20')
@Check('CHK_game_rings_shine', '"shine" = 100')
@Check('CHK_game_rings_comfort', '"comfort" >= 2')
@Check('CHK_game_rings_charm', '"charm" >= 2')
@Check('CHK_game_rings_quality', '"quality" >= 2')
@Check('CHK_game_rings_luck', '"luck" >= 2')
@Check('CHK_game_rings_unspent_attribute_points', '"unspent_attribute_points" BETWEEN 0 AND 76')
@Check('CHK_game_rings_visual_variant', `"visual_variant_code" IN (${sqlStringList(Object.values(CopperVisualVariant))})`)
@Check('CHK_game_rings_ruleset', `"ruleset_version" = '${COPPER_RULESET_VERSION}'`)
@Check('CHK_game_rings_generation', `"generation_version" = '${COPPER_GENERATION_VERSION}'`)
@Check('CHK_game_rings_visual_set', `"visual_set_version" = '${COPPER_VISUAL_SET_VERSION}'`)
@Check('CHK_game_rings_issued_reason', `"issued_reason" IN (${sqlStringList(Object.values(CopperIssuanceReason))})`)
export class GameRing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne(() => User, { onDelete: 'RESTRICT', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'owner_user_id', foreignKeyConstraintName: 'FK_game_rings_owner' })
  owner!: User;

  @Column({ name: 'entitlement_code', type: 'varchar', length: 64 })
  entitlementCode!: string;

  @Column({ name: 'ring_kind', type: 'varchar', length: 32 })
  ringKind!: GameRingKind;

  @Column({ type: 'varchar', length: 32 })
  status!: GameRingStatus;

  @Column({ type: 'smallint' })
  level!: number;

  @Column({ type: 'smallint' })
  shine!: number;

  @Column({ type: 'integer' })
  comfort!: number;

  @Column({ type: 'integer' })
  charm!: number;

  @Column({ type: 'integer' })
  quality!: number;

  @Column({ type: 'integer' })
  luck!: number;

  @Column({ name: 'unspent_attribute_points', type: 'smallint', default: 0 })
  unspentAttributePoints!: number;

  @Column({ name: 'visual_variant_code', type: 'varchar', length: 64 })
  visualVariantCode!: CopperVisualVariant;

  @Column({ name: 'ruleset_version', type: 'varchar', length: 64 })
  rulesetVersion!: string;

  @Column({ name: 'generation_version', type: 'varchar', length: 64 })
  generationVersion!: string;

  @Column({ name: 'visual_set_version', type: 'varchar', length: 64 })
  visualSetVersion!: string;

  @Column({ name: 'issued_reason', type: 'varchar', length: 32 })
  issuedReason!: CopperIssuanceReason;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
