import 'reflect-metadata';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getMetadataArgsStorage } from 'typeorm';
import { EquippedRing } from './equipped-ring.entity';
import {
  COPPER_ENTITLEMENT_CODE,
  COPPER_GENERATION_VERSION,
  COPPER_RULESET_VERSION,
  COPPER_VISUAL_SET_VERSION,
  RAFFLE_COPPER_ENTITLEMENT_PREFIX,
  CopperIssuanceReason,
  CopperVisualVariant,
  GameRing,
  GameRingKind,
  GameRingStatus,
} from './game-ring.entity';
import { RingEvent, RingEventType } from './ring-event.entity';

function tableFor(target: Function) {
  return getMetadataArgsStorage().tables.find((table) => table.target === target);
}

function databaseColumnsFor(target: Function) {
  return getMetadataArgsStorage().columns
    .filter((column) => column.target === target)
    .map((column) => column.options.name ?? column.propertyName)
    .sort();
}

function indexNamesFor(target: Function) {
  return getMetadataArgsStorage().indices
    .filter((index) => index.target === target)
    .map((index) => index.name)
    .sort();
}

function checkNamesFor(target: Function) {
  return getMetadataArgsStorage().checks
    .filter((check) => check.target === target)
    .map((check) => check.name)
    .sort();
}

describe('Copper ring schema metadata', () => {
  it('maps the three Copper aggregate tables and required columns', () => {
    assert.equal(tableFor(GameRing)?.name, 'game_rings');
    assert.equal(tableFor(EquippedRing)?.name, 'equipped_rings');
    assert.equal(tableFor(RingEvent)?.name, 'ring_events');

    assert.deepEqual(databaseColumnsFor(GameRing), [
      'charm',
      'comfort',
      'created_at',
      'entitlement_code',
      'generation_version',
      'id',
      'issued_reason',
      'level',
      'luck',
      'owner_user_id',
      'quality',
      'ring_kind',
      'ruleset_version',
      'shine',
      'status',
      'unspent_attribute_points',
      'updated_at',
      'visual_set_version',
      'visual_variant_code',
    ]);
    assert.deepEqual(databaseColumnsFor(EquippedRing), ['equipped_at', 'ring_id', 'updated_at', 'user_id']);
    assert.deepEqual(databaseColumnsFor(RingEvent), [
      'created_at',
      'event_type',
      'id',
      'operation_key',
      'owner_user_id',
      'ring_id',
      'ruleset_version',
      'snapshot',
    ]);
  });

  it('keeps domain constants aligned with copper-rules-v1', () => {
    assert.equal(COPPER_ENTITLEMENT_CODE, 'starter-copper-v1');
    assert.equal(RAFFLE_COPPER_ENTITLEMENT_PREFIX, 'raffle-copper-v1:');
    assert.equal(COPPER_RULESET_VERSION, 'copper-rules-v1');
    assert.equal(COPPER_GENERATION_VERSION, 'copper-generation-v1');
    assert.equal(COPPER_VISUAL_SET_VERSION, 'copper-visual-v1');
    assert.deepEqual(Object.values(GameRingKind), ['COPPER']);
    assert.deepEqual(Object.values(GameRingStatus), ['ACTIVE']);
    assert.deepEqual(Object.values(CopperIssuanceReason).sort(), [
      'LAZY_ENSURE',
      'LEGACY_BACKFILL',
      'RAFFLE',
      'REGISTRATION',
    ]);
    assert.deepEqual(Object.values(RingEventType), [
      'STARTER_ISSUED',
      'LEVEL_UP',
      'ATTRIBUTE_POINTS_ALLOCATED',
      'RAFFLE_AWARDED',
      'EQUIPPED',
    ]);
    assert.deepEqual(Object.values(CopperVisualVariant).sort(), [
      'copper_celtic',
      'copper_filigree',
      'copper_geometric',
      'copper_leaves',
      'copper_milgrain',
      'copper_plain_polished',
      'copper_rune_rough',
      'copper_signet',
      'copper_twisted',
    ]);
  });

  it('declares owner, equipment, audit, and value constraints in entity metadata', () => {
    assert.deepEqual(indexNamesFor(GameRing), [
      'IDX_game_rings_owner_created',
      'UQ_game_rings_id_owner',
      'UQ_game_rings_owner_entitlement',
    ]);
    assert.deepEqual(indexNamesFor(EquippedRing), ['UQ_equipped_rings_ring']);
    assert.deepEqual(indexNamesFor(RingEvent), [
      'IDX_ring_events_owner_created',
      'IDX_ring_events_ring_created',
      'UQ_ring_events_award_identity',
      'UQ_ring_events_operation_key',
      'UQ_ring_events_raffle_awarded',
      'UQ_ring_events_starter_issued',
    ]);
    assert.deepEqual(checkNamesFor(GameRing), [
      'CHK_game_rings_charm',
      'CHK_game_rings_comfort',
      'CHK_game_rings_entitlement',
      'CHK_game_rings_generation',
      'CHK_game_rings_issued_reason',
      'CHK_game_rings_kind',
      'CHK_game_rings_level',
      'CHK_game_rings_luck',
      'CHK_game_rings_quality',
      'CHK_game_rings_ruleset',
      'CHK_game_rings_shine',
      'CHK_game_rings_status',
      'CHK_game_rings_unspent_attribute_points',
      'CHK_game_rings_visual_set',
      'CHK_game_rings_visual_variant',
    ]);
    assert.deepEqual(checkNamesFor(RingEvent), [
      'CHK_ring_events_ruleset',
      'CHK_ring_events_snapshot',
      'CHK_ring_events_type',
    ]);
  });
});
