import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { canonicalEru, displayEru, parseUnsignedEruDecimal } from '../balance/eru-decimal';
import { canonicalErt, displayErt, parseUnsignedErtDecimal } from '../m2e/ert-decimal';
import { validateRaffleV2Configuration } from '../raffle/raffle-v2-configuration-validator';

type ConfigurationRow = {
  machineId: string;
  machineCode: string;
  machineCreatedAt: Date;
  machineAvailable: boolean;
  machinePausedAt: Date | null;
  configurationId: string | null;
  contractVersion: string | null;
  status: string | null;
  title: string | null;
  description: string | null;
  costErtExact: string | null;
  dailyUserAttemptLimit: number | null;
  createdByUserId: string | null;
  createdAt: Date | null;
  activatedAt: Date | null;
  disabledAt: Date | null;
};

type RewardRow = {
  configurationId: string;
  rewardId: string;
  segmentIndex: number;
  weight: number;
  rewardSnapshot: Record<string, unknown>;
  liveCode: string;
  liveTitle: string;
  liveType: string;
  liveActive: boolean;
  liveStockTotal: number | null;
  liveStockRemaining: number | null;
  livePerUserLimit: number | null;
  liveDailyGlobalLimit: number | null;
};

@Injectable()
export class AdminRaffleV2Service {
  constructor(private readonly dataSource: DataSource) {}

  async overview() {
    const configurations = await this.dataSource.query(`
      SELECT
        machine."id" AS "machineId",
        machine."code" AS "machineCode",
        machine."created_at" AS "machineCreatedAt",
        machine."is_available" AS "machineAvailable",
        machine."paused_at" AS "machinePausedAt",
        configuration."id" AS "configurationId",
        configuration."contract_version" AS "contractVersion",
        configuration."status" AS "status",
        configuration."title" AS "title",
        configuration."description" AS "description",
        configuration."cost_ert"::text AS "costErtExact",
        configuration."daily_user_attempt_limit" AS "dailyUserAttemptLimit",
        configuration."created_by_user_id" AS "createdByUserId",
        configuration."created_at" AS "createdAt",
        configuration."activated_at" AS "activatedAt",
        configuration."disabled_at" AS "disabledAt"
      FROM "raffle_machines" machine
      LEFT JOIN "raffle_configurations" configuration
        ON configuration."machine_id" = machine."id"
      WHERE machine."singleton_key" = 1
      ORDER BY configuration."created_at" DESC NULLS LAST, configuration."id" DESC NULLS LAST
    `) as ConfigurationRow[];
    if (configurations.length === 0) return { machine: null, configurations: [] };

    const machine = configurations[0];
    const configurationIds = configurations
      .map((row) => row.configurationId)
      .filter((id): id is string => id !== null);
    const rewardRows = configurationIds.length === 0 ? [] : await this.dataSource.query(`
      SELECT
        mapping."configuration_id" AS "configurationId",
        mapping."reward_id" AS "rewardId",
        mapping."segment_index" AS "segmentIndex",
        mapping."weight" AS "weight",
        mapping."reward_snapshot" AS "rewardSnapshot",
        reward."code" AS "liveCode",
        reward."title" AS "liveTitle",
        reward."type" AS "liveType",
        reward."is_active" AS "liveActive",
        reward."stock_total" AS "liveStockTotal",
        reward."stock_remaining" AS "liveStockRemaining",
        reward."per_user_limit" AS "livePerUserLimit",
        reward."daily_global_limit" AS "liveDailyGlobalLimit"
      FROM "raffle_configuration_rewards" mapping
      INNER JOIN "rewards" reward ON reward."id" = mapping."reward_id"
      WHERE mapping."configuration_id" = ANY($1::uuid[])
      ORDER BY mapping."configuration_id", mapping."segment_index", mapping."reward_id"
    `, [configurationIds]) as RewardRow[];
    const rewardsByConfiguration = new Map<string, RewardRow[]>();
    for (const row of rewardRows) {
      const rows = rewardsByConfiguration.get(row.configurationId) ?? [];
      rows.push(row);
      rewardsByConfiguration.set(row.configurationId, rows);
    }

    return {
      machine: {
        id: machine.machineId,
        code: machine.machineCode,
        available: machine.machineAvailable,
        pausedAt: machine.machinePausedAt === null ? null : iso(machine.machinePausedAt),
        createdAt: iso(machine.machineCreatedAt),
      },
      configurations: configurations
        .filter((row) => row.configurationId !== null)
        .map((row) => this.configurationContract(row, rewardsByConfiguration.get(row.configurationId!) ?? [])),
    };
  }

  async draws(input: { limit: number; offset: number }) {
    const limit = boundedInteger(input.limit, 'limit', 1, 100);
    const offset = boundedInteger(input.offset, 'offset', 0, 1_000_000);
    const rows = await this.dataSource.query(`
      SELECT
        result."id" AS "drawResultId",
        result."operation_id" AS "operationId",
        result."owner_user_id" AS "ownerUserId",
        result."machine_id" AS "machineId",
        result."configuration_id" AS "configurationId",
        result."selected_reward_id" AS "selectedRewardId",
        result."selected_segment_index" AS "selectedSegmentIndex",
        result."algorithm" AS "algorithm",
        result."ticket" AS "ticket",
        result."total_weight" AS "totalWeight",
        result."ranges_snapshot" AS "rangesSnapshot",
        result."cost_ert"::text AS "costErtExact",
        result."created_at" AS "createdAt",
        operation."idempotency_key" AS "idempotencyKey",
        operation."status" AS "operationStatus",
        operation."response_snapshot" AS "responseSnapshot",
        operation."completed_at" AS "completedAt",
        reward."code" AS "rewardCode",
        reward."title" AS "rewardTitle",
        reward."type" AS "rewardType",
        award."id" AS "ringAwardId",
        award."ring_id" AS "ringId",
        award."ring_event_id" AS "ringEventId"
      FROM "raffle_draw_results_v2" result
      INNER JOIN "raffle_draw_operations" operation ON operation."id" = result."operation_id"
      INNER JOIN "rewards" reward ON reward."id" = result."selected_reward_id"
      LEFT JOIN "raffle_ring_awards" award ON award."draw_result_id" = result."id"
      ORDER BY result."created_at" DESC, result."id" DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]) as Array<Record<string, unknown>>;
    return {
      limit,
      offset,
      items: rows.map((row) => {
        const costErtExact = exactErt(row.costErtExact);
        return {
          ...row,
          ticket: exactInteger(row.ticket, 'ticket'),
          totalWeight: exactInteger(row.totalWeight, 'totalWeight'),
          costErtExact,
          costErtDisplay: displayErt(costErtExact),
          createdAt: iso(row.createdAt),
          completedAt: row.completedAt === null ? null : iso(row.completedAt),
          responseSnapshot: withEruDisplayEvidence(row.responseSnapshot),
        };
      }),
    };
  }

  async createReward(input: unknown) {
    const reward = parseRewardDraft(input);
    try {
      const [created] = await this.dataSource.query(`
        INSERT INTO "rewards" (
          "code", "title", "description", "type", "amount", "amount_exact",
          "metadata", "image_url", "is_active", "stock_total", "stock_remaining",
          "per_user_limit", "daily_global_limit"
        ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, true, $8, $9, $10, $11)
        RETURNING
          "id", "code", "title", "description", "type",
          "amount"::text AS "amount",
          "amount_exact"::text AS "amountExact",
          "image_url" AS "imageUrl",
          "is_active" AS "active",
          "stock_total" AS "stockTotal",
          "stock_remaining" AS "stockRemaining",
          "per_user_limit" AS "perUserLimit",
          "daily_global_limit" AS "dailyGlobalLimit",
          "created_at" AS "createdAt"
      `, [
        reward.code, reward.title, reward.description, reward.type,
        reward.type === 'ERT' ? reward.amountExact : null,
        reward.type === 'ERU' ? reward.amountExact : null,
        reward.imageUrl, reward.stockTotal, reward.stockRemaining,
        reward.perUserLimit, reward.dailyGlobalLimit,
      ]) as Array<Record<string, unknown>>;
      if (created.type !== 'ERU') return created;
      const amountExact = positiveEruDecimal(created.amountExact, 'persisted ERU amount');
      return { ...created, amount: null, amountExact, amountDisplay: displayEru(amountExact) };
    } catch (error) {
      if (postgresCode(error) === '23505') throw new ConflictException('Reward code already exists');
      throw error;
    }
  }

  async createDraft(createdByUserId: string, input: unknown) {
    const draft = parseConfigurationDraft(input, true);
    const createdRows = (await this.dataSource.query(`
      INSERT INTO "raffle_configurations" (
        "machine_id", "contract_version", "status", "title", "description",
        "cost_ert", "daily_user_attempt_limit", "created_by_user_id"
      )
      SELECT "id", 'raffle-v2', 'DRAFT', $1, $2, $3, $4, $5
      FROM "raffle_machines"
      WHERE "singleton_key" = 1
      RETURNING
        "id", "machine_id" AS "machineId", "contract_version" AS "contractVersion",
        "status", "title", "description", "cost_ert"::text AS "costErtExact",
        "daily_user_attempt_limit" AS "dailyUserAttemptLimit",
        "created_by_user_id" AS "createdByUserId", "created_at" AS "createdAt"
    `, [draft.title, draft.description, draft.costErtExact, draft.dailyUserAttemptLimit, createdByUserId])) as Array<Record<string, unknown>>;
    const created = createdRows[0];
    if (!created) throw new ConflictException('Raffle v2 singleton machine is unavailable');
    return created;
  }

  async updateDraft(configurationId: string, input: unknown) {
    const draft = parseConfigurationDraft(input, false);
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of [
      ['title', draft.title],
      ['description', draft.description],
      ['cost_ert', draft.costErtExact],
      ['daily_user_attempt_limit', draft.dailyUserAttemptLimit],
    ] as const) {
      if (value !== undefined) {
        values.push(value);
        assignments.push(`"${column}" = $${values.length}`);
      }
    }
    values.push(configurationId);
    const rows = updateRows<Record<string, unknown>>(await this.dataSource.query(`
      UPDATE "raffle_configurations"
      SET ${assignments.join(', ')}
      WHERE "id" = $${values.length} AND "status" = 'DRAFT'
      RETURNING
        "id", "machine_id" AS "machineId", "contract_version" AS "contractVersion",
        "status", "title", "description", "cost_ert"::text AS "costErtExact",
        "daily_user_attempt_limit" AS "dailyUserAttemptLimit",
        "created_by_user_id" AS "createdByUserId", "created_at" AS "createdAt"
    `, values));
    if (rows[0]) return rows[0];
    await this.requireDraft(configurationId);
    throw new ConflictException('Raffle v2 configuration is not editable');
  }

  async replaceDraftRewards(configurationId: string, input: unknown) {
    const outcomes = parseDraftOutcomes(input);
    return this.dataSource.transaction(async (manager) => {
      const configurations = await manager.query(`
        SELECT "id", "status" FROM "raffle_configurations" WHERE "id" = $1 FOR UPDATE
      `, [configurationId]) as Array<{ id: string; status: string }>;
      if (!configurations[0]) throw new NotFoundException('Raffle v2 configuration not found');
      if (configurations[0].status !== 'DRAFT') {
        throw new ConflictException('Only a DRAFT Raffle v2 configuration can be edited');
      }
      const rewardIds = outcomes.map((outcome) => outcome.rewardId);
      const rewards = await manager.query(`
        SELECT
          "id", "code", "title", "type", "amount"::text AS "amount",
          "amount_exact"::text AS "amountExact", "image_url" AS "imageUrl",
          "is_active" AS "active", "stock_total" AS "stockTotal",
          "stock_remaining" AS "stockRemaining", "per_user_limit" AS "perUserLimit",
          "daily_global_limit" AS "dailyGlobalLimit"
        FROM "rewards"
        WHERE "id" = ANY($1::uuid[])
        ORDER BY "id"
        FOR SHARE
      `, [rewardIds]) as CatalogRewardRow[];
      const byId = new Map(rewards.map((reward) => [reward.id, reward]));
      if (byId.size !== rewardIds.length) throw new BadRequestException('A selected reward does not exist');
      const totalWeight = outcomes.reduce((sum, outcome) => sum + outcome.weight, 0);
      await manager.query(`DELETE FROM "raffle_configuration_rewards" WHERE "configuration_id" = $1`, [configurationId]);
      for (const [segmentIndex, outcome] of outcomes.entries()) {
        const reward = requireDraftReward(byId.get(outcome.rewardId));
        const snapshot = draftRewardSnapshot(reward, segmentIndex, outcome.weight, totalWeight);
        await manager.query(`
          INSERT INTO "raffle_configuration_rewards" (
            "configuration_id", "reward_id", "segment_index", "weight", "reward_snapshot"
          ) VALUES ($1, $2, $3, $4, $5::jsonb)
        `, [configurationId, reward.id, segmentIndex, outcome.weight, JSON.stringify(snapshot)]);
      }
      return {
        configurationId,
        totalWeight: String(totalWeight),
        rewards: outcomes.map((outcome, segmentIndex) => ({
          rewardId: outcome.rewardId,
          segmentIndex,
          weight: String(outcome.weight),
          probability: { numerator: String(outcome.weight), denominator: String(totalWeight) },
        })),
      };
    });
  }

  async previewDraft(configurationId: string) {
    const candidate = await this.loadDraftCandidate(this.dataSource, configurationId);
    return {
      configurationId,
      status: candidate.status,
      ...validateRaffleV2Configuration(candidate),
    };
  }

  async activateDraft(adminUserId: string, configurationId: string, input: unknown) {
    const request = parseActivationRequest(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      adminUserId: adminUserId.toLowerCase(),
      configurationId: configurationId.toLowerCase(),
      expectedActiveConfigurationVersion: request.expectedActiveConfigurationVersion,
      reason: request.reason,
      contractVersion: 'raffle-admin-activation-v1',
    })).digest('hex');

    return this.dataSource.transaction(async (manager) => {
      const machines = await manager.query(`
        SELECT "id" FROM "raffle_machines" WHERE "singleton_key" = 1 FOR UPDATE
      `) as Array<{ id: string }>;
      const machine = machines[0];
      if (!machine) throw new ConflictException('Raffle v2 singleton machine is unavailable');

      const existingRows = await manager.query(`
        SELECT "request_fingerprint" AS "requestFingerprint", "status", "response_snapshot" AS "responseSnapshot"
        FROM "raffle_configuration_activation_operations"
        WHERE "admin_user_id" = $1 AND "idempotency_key" = $2
        FOR UPDATE
      `, [adminUserId, request.idempotencyKey]) as Array<{
        requestFingerprint: string; status: string; responseSnapshot: Record<string, unknown> | null;
      }>;
      const existing = existingRows[0];
      if (existing) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new ConflictException('Raffle v2 activation idempotency key was used for another request');
        }
        if (existing.status !== 'COMPLETED' || !existing.responseSnapshot) {
          throw new ConflictException('Raffle v2 activation operation is incomplete');
        }
        return { ...existing.responseSnapshot, replay: true };
      }

      const activeRows = await manager.query(`
        SELECT "id" FROM "raffle_configurations"
        WHERE "machine_id" = $1 AND "status" = 'ACTIVE'
        FOR UPDATE
      `, [machine.id]) as Array<{ id: string }>;
      const previousActiveConfigurationId = activeRows[0]?.id ?? null;
      if (previousActiveConfigurationId !== request.expectedActiveConfigurationVersion) {
        throw new ConflictException('Active Raffle v2 configuration changed; refresh and retry');
      }

      const candidate = await this.loadDraftCandidate(manager, configurationId, true);
      const validation = validateRaffleV2Configuration(candidate);
      if (!validation.valid) {
        throw new BadRequestException({
          code: 'RAFFLE_V2_CONFIGURATION_INVALID',
          message: 'Raffle v2 draft cannot be activated',
          validation,
        });
      }

      const operationRows = await manager.query(`
        INSERT INTO "raffle_configuration_activation_operations" (
          "machine_id", "target_configuration_id", "expected_active_configuration_id",
          "previous_active_configuration_id", "admin_user_id", "reason", "idempotency_key",
          "request_fingerprint", "contract_version", "status"
        ) VALUES ($1, $2, $3, $3, $4, $5, $6, $7, 'raffle-admin-activation-v1', 'PENDING')
        RETURNING "id"
      `, [machine.id, configurationId, previousActiveConfigurationId, adminUserId,
        request.reason, request.idempotencyKey, fingerprint]) as Array<{ id: string }>;
      const operation = operationRows[0];
      if (!operation) throw new ConflictException('Raffle v2 activation operation could not be claimed');

      let disabledAt: Date | null = null;
      if (previousActiveConfigurationId) {
        const disabledRows = updateRows<{ disabledAt: Date }>(await manager.query(`
          UPDATE "raffle_configurations"
          SET "status" = 'DISABLED', "disabled_at" = clock_timestamp()
          WHERE "id" = $1 AND "status" = 'ACTIVE'
          RETURNING "disabled_at" AS "disabledAt"
        `, [previousActiveConfigurationId]));
        if (!disabledRows[0]) throw new ConflictException('Expected active Raffle v2 configuration is unavailable');
        disabledAt = disabledRows[0].disabledAt;
      }
      const activatedRows = updateRows<{ activatedAt: Date }>(await manager.query(`
        UPDATE "raffle_configurations"
        SET "status" = 'ACTIVE', "activated_at" = clock_timestamp()
        WHERE "id" = $1 AND "machine_id" = $2 AND "status" = 'DRAFT'
        RETURNING "activated_at" AS "activatedAt"
      `, [configurationId, machine.id]));
      if (!activatedRows[0]) throw new ConflictException('Raffle v2 draft is no longer activatable');

      const response = {
        operationId: operation.id,
        contractVersion: 'raffle-admin-activation-v1',
        replay: false,
        machineId: machine.id,
        previousActiveConfigurationVersion: previousActiveConfigurationId,
        activeConfigurationVersion: configurationId,
        activatedAt: iso(activatedRows[0].activatedAt),
        disabledAt: disabledAt ? iso(disabledAt) : null,
        adminUserId,
        reason: request.reason,
        validation,
      };
      const completed = updateRows<{ id: string }>(await manager.query(`
        UPDATE "raffle_configuration_activation_operations"
        SET "status" = 'COMPLETED', "response_snapshot" = $2::jsonb, "completed_at" = clock_timestamp()
        WHERE "id" = $1 AND "status" = 'PENDING'
        RETURNING "id"
      `, [operation.id, JSON.stringify(response)]));
      if (!completed[0]) throw new ConflictException('Raffle v2 activation operation could not be completed');
      return response;
    });
  }

  async setAvailability(adminUserId: string, action: 'PAUSE' | 'RESUME', input: unknown) {
    const request = parseAvailabilityRequest(input, action);
    const resultAvailable = action === 'RESUME';
    const fingerprint = createHash('sha256').update(JSON.stringify({
      adminUserId: adminUserId.toLowerCase(), action,
      expectedAvailable: request.expectedAvailable, reason: request.reason,
    })).digest('hex');
    return this.dataSource.transaction(async (manager) => {
      const machines = await manager.query(`SELECT "id", "is_available" AS "available", "paused_at" AS "pausedAt"
        FROM "raffle_machines" WHERE "singleton_key" = 1 FOR UPDATE`) as Array<{
        id: string; available: boolean; pausedAt: Date | null;
      }>;
      const machine = machines[0];
      if (!machine) throw new ConflictException('Raffle v2 singleton machine is unavailable');
      const existingRows = await manager.query(`SELECT "request_fingerprint" AS "requestFingerprint",
        "response_snapshot" AS "responseSnapshot" FROM "raffle_machine_availability_operations"
        WHERE "admin_user_id" = $1 AND "idempotency_key" = $2`,
      [adminUserId, request.idempotencyKey]) as Array<{
        requestFingerprint: string; responseSnapshot: Record<string, unknown>;
      }>;
      if (existingRows[0]) {
        if (existingRows[0].requestFingerprint !== fingerprint) {
          throw new ConflictException('Raffle v2 availability idempotency key was used for another request');
        }
        return { ...existingRows[0].responseSnapshot, replay: true };
      }
      if (machine.available !== request.expectedAvailable) {
        throw new ConflictException('Raffle v2 availability changed; refresh and retry');
      }
      const changedRows = updateRows<{ available: boolean; pausedAt: Date | null }>(await manager.query(`UPDATE "raffle_machines"
        SET "is_available" = $2, "paused_at" = CASE WHEN $2 THEN NULL ELSE clock_timestamp() END
        WHERE "id" = $1 AND "is_available" = $3
        RETURNING "is_available" AS "available", "paused_at" AS "pausedAt"`,
      [machine.id, resultAvailable, request.expectedAvailable]));
      if (!changedRows[0]) throw new ConflictException('Raffle v2 availability changed; refresh and retry');
      const operationId = randomUUID();
      const response = {
        operationId,
        operationContractVersion: 'raffle-admin-availability-v1', replay: false,
        machineId: machine.id, action, previousAvailable: machine.available,
        available: changedRows[0].available,
        pausedAt: changedRows[0].pausedAt ? iso(changedRows[0].pausedAt) : null,
        adminUserId, reason: request.reason,
      };
      const operations = await manager.query(`INSERT INTO "raffle_machine_availability_operations" (
        "id", "machine_id", "admin_user_id", "action", "expected_available", "result_available",
        "reason", "idempotency_key", "request_fingerprint", "response_snapshot"
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING "id"`, [
        operationId, machine.id, adminUserId, action, request.expectedAvailable, resultAvailable,
        request.reason, request.idempotencyKey, fingerprint, JSON.stringify(response),
      ]) as Array<{ id: string }>;
      if (!operations[0]) throw new ConflictException('Raffle v2 availability operation could not be persisted');
      return response;
    });
  }

  private async loadDraftCandidate(
    queryable: { query(sql: string, parameters?: unknown[]): Promise<unknown> },
    configurationId: string,
    locked = false,
  ) {
    const configurations = await queryable.query(`
      SELECT
        "id", "status", "cost_ert"::text AS "costErtExact",
        "daily_user_attempt_limit" AS "dailyUserAttemptLimit"
      FROM "raffle_configurations"
      WHERE "id" = $1
      ${locked ? 'FOR UPDATE' : ''}
    `, [configurationId]) as Array<{
      id: string; status: string; costErtExact: string; dailyUserAttemptLimit: number;
    }>;
    const configuration = configurations[0];
    if (!configuration) throw new NotFoundException('Raffle v2 configuration not found');
    if (configuration.status !== 'DRAFT') {
      throw new ConflictException('Only a DRAFT Raffle v2 configuration can be previewed');
    }
    const rewards = await queryable.query(`
      SELECT
        mapping."reward_id" AS "rewardId",
        mapping."segment_index" AS "segmentIndex",
        mapping."weight" AS "weight",
        mapping."reward_snapshot" AS "snapshot",
        reward."id" AS "liveId",
        reward."type" AS "liveType",
        reward."is_active" AS "liveActive",
        reward."amount"::text AS "liveAmount",
        reward."amount_exact"::text AS "liveAmountExact",
        reward."stock_total" AS "stockTotal",
        reward."stock_remaining" AS "stockRemaining",
        reward."per_user_limit" AS "perUserLimit",
        reward."daily_global_limit" AS "dailyGlobalLimit"
      FROM "raffle_configuration_rewards" mapping
      INNER JOIN "rewards" reward ON reward."id" = mapping."reward_id"
      WHERE mapping."configuration_id" = $1
      ORDER BY mapping."segment_index", mapping."reward_id"
      ${locked ? 'FOR SHARE OF mapping, reward' : ''}
    `, [configurationId]) as DraftValidationRewardRow[];
    return {
      status: configuration.status,
      costErtExact: configuration.costErtExact,
      dailyUserAttemptLimit: configuration.dailyUserAttemptLimit,
      rewards: rewards.map((reward) => ({
        rewardId: reward.rewardId,
        segmentIndex: reward.segmentIndex,
        weight: reward.weight,
        snapshot: reward.snapshot,
        live: {
          id: reward.liveId,
          type: reward.liveType,
          active: reward.liveActive,
          amount: reward.liveAmount,
          amountExact: reward.liveAmountExact,
          stockTotal: reward.stockTotal,
          stockRemaining: reward.stockRemaining,
          perUserLimit: reward.perUserLimit,
          dailyGlobalLimit: reward.dailyGlobalLimit,
        },
      })),
    };
  }

  private async requireDraft(configurationId: string) {
    const rows = await this.dataSource.query(
      `SELECT "status" FROM "raffle_configurations" WHERE "id" = $1`,
      [configurationId],
    ) as Array<{ status: string }>;
    if (!rows[0]) throw new NotFoundException('Raffle v2 configuration not found');
    if (rows[0].status !== 'DRAFT') throw new ConflictException('Only a DRAFT Raffle v2 configuration can be edited');
    return rows[0];
  }

  private configurationContract(row: ConfigurationRow, rewards: RewardRow[]) {
    const totalWeight = rewards.reduce((sum, reward) => {
      const weight = positiveInteger(reward.weight, 'weight');
      const next = sum + weight;
      if (!Number.isSafeInteger(next)) throw new Error('Raffle v2 total weight is unsafe');
      return next;
    }, 0);
    const costErtExact = exactErt(row.costErtExact);
    return {
      id: row.configurationId,
      contractVersion: row.contractVersion,
      status: row.status,
      title: row.title,
      description: row.description,
      cost: { currency: 'ERT', amountExact: costErtExact, amountDisplay: displayErt(costErtExact) },
      dailyUserAttemptLimit: positiveInteger(row.dailyUserAttemptLimit, 'dailyUserAttemptLimit'),
      createdByUserId: row.createdByUserId,
      createdAt: iso(row.createdAt),
      activatedAt: row.activatedAt === null ? null : iso(row.activatedAt),
      disabledAt: row.disabledAt === null ? null : iso(row.disabledAt),
      totalWeight: String(totalWeight),
      rewards: rewards.map((reward) => ({
        rewardId: reward.rewardId,
        segmentIndex: nonNegativeInteger(reward.segmentIndex, 'segmentIndex'),
        weight: String(positiveInteger(reward.weight, 'weight')),
        probability: { numerator: String(reward.weight), denominator: String(totalWeight) },
        snapshot: withEruDisplayEvidence(reward.rewardSnapshot),
        live: {
          code: reward.liveCode,
          title: reward.liveTitle,
          type: reward.liveType,
          active: reward.liveActive,
          stockTotal: reward.liveStockTotal,
          stockRemaining: reward.liveStockRemaining,
          perUserLimit: reward.livePerUserLimit,
          dailyGlobalLimit: reward.liveDailyGlobalLimit,
        },
      })),
    };
  }
}

type CatalogRewardRow = {
  id: string;
  code: string;
  title: string;
  type: string;
  amount: string | null;
  amountExact: string | null;
  imageUrl: string | null;
  active: boolean;
  stockTotal: number | null;
  stockRemaining: number | null;
  perUserLimit: number | null;
  dailyGlobalLimit: number | null;
};

type DraftValidationRewardRow = {
  rewardId: string;
  segmentIndex: number;
  weight: number;
  snapshot: Record<string, unknown>;
  liveId: string;
  liveType: string;
  liveActive: boolean;
  liveAmount: string | null;
  liveAmountExact: string | null;
  stockTotal: number | null;
  stockRemaining: number | null;
  perUserLimit: number | null;
  dailyGlobalLimit: number | null;
};

function parseRewardDraft(input: unknown) {
  const value = exactRecord(input, [
    'code', 'title', 'description', 'type', 'amountExact', 'imageUrl',
    'stockTotal', 'stockRemaining', 'perUserLimit', 'dailyGlobalLimit',
  ]);
  const type = enumString(value.type, ['ERT', 'ERU', 'COPPER_RING'], 'type');
  const amountExact = type === 'COPPER_RING'
    ? optionalNull(value.amountExact, 'amountExact')
    : type === 'ERU'
      ? positiveEruDecimal(value.amountExact, 'amountExact')
      : positiveIntegerString(value.amountExact, 15, 'amountExact');
  const stockTotal = nullableNonNegativeInteger(value.stockTotal, 'stockTotal');
  const stockRemaining = nullableNonNegativeInteger(value.stockRemaining, 'stockRemaining');
  const perUserLimit = nullablePositiveInteger(value.perUserLimit, 'perUserLimit');
  const dailyGlobalLimit = nullablePositiveInteger(value.dailyGlobalLimit, 'dailyGlobalLimit');
  if ((stockTotal === null) !== (stockRemaining === null)
    || (stockTotal !== null && stockRemaining !== null && stockRemaining > stockTotal)) {
    throw new BadRequestException('stockTotal and stockRemaining must be consistent');
  }
  if (type === 'COPPER_RING' && [stockTotal, stockRemaining].some((item) => item !== null)) {
    throw new BadRequestException('Cooper Ring supply is unlimited in the current off-chain contract');
  }
  return {
    code: boundedText(value.code, 'code', 64),
    title: boundedText(value.title, 'title', 128),
    description: nullableText(value.description, 'description'),
    type,
    amountExact,
    imageUrl: nullableText(value.imageUrl, 'imageUrl', 512),
    stockTotal,
    stockRemaining,
    perUserLimit,
    dailyGlobalLimit,
  };
}

function parseConfigurationDraft(input: unknown, complete: boolean) {
  const value = partialRecord(input, ['title', 'description', 'costErtExact', 'dailyUserAttemptLimit']);
  if (!complete && Object.keys(value).length === 0) throw new BadRequestException('At least one draft field is required');
  const result = {
    title: value.title === undefined ? undefined : boundedText(value.title, 'title', 128),
    description: value.description === undefined
      ? (complete ? null : undefined)
      : nullableText(value.description, 'description'),
    costErtExact: value.costErtExact === undefined ? undefined : canonicalCost(value.costErtExact),
    dailyUserAttemptLimit: value.dailyUserAttemptLimit === undefined
      ? undefined
      : boundedPositiveInteger(value.dailyUserAttemptLimit, 'dailyUserAttemptLimit', 32767),
  };
  if (complete && (result.title === undefined
    || result.costErtExact === undefined
    || result.dailyUserAttemptLimit === undefined)) {
    throw new BadRequestException('A complete Raffle v2 draft is required');
  }
  return result;
}

function parseDraftOutcomes(input: unknown) {
  const record = exactRecord(input, ['rewards']);
  if (!Array.isArray(record.rewards) || record.rewards.length === 0 || record.rewards.length > 100) {
    throw new BadRequestException('rewards must contain from 1 to 100 outcomes');
  }
  const ids = new Set<string>();
  let total = 0;
  return record.rewards.map((item, index) => {
    const row = exactRecord(item, ['rewardId', 'weight']);
    const rewardId = uuid(row.rewardId, `rewards[${index}].rewardId`);
    if (ids.has(rewardId)) throw new BadRequestException('A reward can appear only once per configuration');
    ids.add(rewardId);
    const weight = boundedPositiveInteger(row.weight, `rewards[${index}].weight`, 2_147_483_647);
    total += weight;
    if (!Number.isSafeInteger(total) || total > 2_147_483_647) {
      throw new BadRequestException('Total reward weight exceeds the supported range');
    }
    return { rewardId, weight };
  });
}

function parseActivationRequest(input: unknown) {
  const value = exactRecord(input, ['expectedActiveConfigurationVersion', 'reason', 'idempotencyKey']);
  return {
    expectedActiveConfigurationVersion: value.expectedActiveConfigurationVersion === null
      ? null
      : uuid(value.expectedActiveConfigurationVersion, 'expectedActiveConfigurationVersion'),
    reason: boundedText(value.reason, 'reason', 512),
    idempotencyKey: uuid(value.idempotencyKey, 'idempotencyKey'),
  };
}

function parseAvailabilityRequest(input: unknown, action: 'PAUSE' | 'RESUME') {
  const value = exactRecord(input, ['expectedAvailable', 'reason', 'idempotencyKey']);
  const expected = action === 'PAUSE';
  if (value.expectedAvailable !== expected) {
    throw new BadRequestException(`expectedAvailable must be ${expected} for ${action}`);
  }
  return {
    expectedAvailable: expected,
    reason: boundedText(value.reason, 'reason', 512),
    idempotencyKey: uuid(value.idempotencyKey, 'idempotencyKey'),
  };
}

function requireDraftReward(value: CatalogRewardRow | undefined) {
  if (!value || !value.active || !['ERT', 'ERU', 'COPPER_RING'].includes(value.type)) {
    throw new BadRequestException('Only active supported Raffle v2 rewards can be selected');
  }
  if (value.type === 'ERT') positiveIntegerString(value.amount, 15, 'persisted ERT amount');
  if (value.type === 'ERU') {
    return { ...value, amountExact: positiveEruDecimal(value.amountExact, 'persisted ERU amount') };
  }
  if (value.type === 'COPPER_RING' && (value.amount !== null || value.amountExact !== null
    || value.stockTotal !== null || value.stockRemaining !== null)) {
    throw new BadRequestException('Persisted Cooper Ring reward violates its contract');
  }
  return value;
}

function draftRewardSnapshot(reward: CatalogRewardRow, segmentIndex: number, weight: number, totalWeight: number) {
  const amountExact = reward.type === 'ERT' ? reward.amount : reward.type === 'ERU' ? reward.amountExact : null;
  return {
    rewardId: reward.id,
    code: reward.code,
    title: reward.title,
    type: reward.type,
    segmentIndex,
    weight: String(weight),
    probability: { numerator: String(weight), denominator: String(totalWeight) },
    imageUrl: reward.imageUrl,
    amountExact,
    amountDisplay: reward.type === 'ERT' && amountExact !== null
      ? displayErt(amountExact)
      : reward.type === 'ERU' && amountExact !== null ? displayEru(amountExact) : null,
    ...(reward.type === 'COPPER_RING' ? {
      asset: { kind: 'RING', rarity: 'COPPER', displayRarity: 'Cooper', quantity: 1 },
    } : {}),
  };
}

function partialRecord(input: unknown, allowedKeys: string[]) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('A JSON object is required');
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) {
    throw new BadRequestException('Request contains unsupported fields');
  }
  return value;
}

function exactRecord(input: unknown, allowedKeys: string[]) {
  return partialRecord(input, allowedKeys);
}

function boundedText(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximum) {
    throw new BadRequestException(`${field} must be non-empty canonical text up to ${maximum} characters`);
  }
  return value;
}

function nullableText(value: unknown, field: string, maximum = 4096) {
  if (value === undefined || value === null || value === '') return null;
  return boundedText(value, field, maximum);
}

function enumString<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BadRequestException(`${field} is unsupported`);
  }
  return value as T;
}

function optionalNull(value: unknown, field: string): null {
  if (value !== undefined && value !== null) throw new BadRequestException(`${field} must be null`);
  return null;
}

function positiveIntegerString(value: unknown, maximumDigits: number, field: string) {
  if (typeof value !== 'string' || !new RegExp(`^[1-9][0-9]{0,${maximumDigits - 1}}$`).test(value)) {
    throw new BadRequestException(`${field} must be a canonical positive integer string`);
  }
  return value;
}

function positiveEruDecimal(value: unknown, field: string) {
  try {
    const amount = canonicalEru(value, field);
    parseUnsignedEruDecimal(amount, field, false);
    return amount;
  } catch {
    throw new BadRequestException(`${field} must be a positive ERU decimal with at most 30 integer and 18 fractional digits`);
  }
}

function withEruDisplayEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withEruDisplayEvidence);
  if (value === null || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, nested]) => [key, withEruDisplayEvidence(nested)]));
  if (result.type === 'ERU' && result.amountExact !== null && result.amountExact !== undefined) {
    const exact = positiveEruDecimal(result.amountExact, 'persisted ERU amount');
    result.amountExact = exact;
    result.amountDisplay = displayEru(exact);
  }
  if (result.type === 'ERU_CREDIT' && result.balanceAfterExact !== null
    && result.balanceAfterExact !== undefined) {
    const exact = canonicalEru(result.balanceAfterExact, 'persisted ERU balance');
    result.balanceAfterExact = exact;
    result.balanceAfterDisplay = displayEru(exact);
  }
  return result;
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException(`${field} must be a non-negative safe integer or null`);
  }
  return value;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  return boundedPositiveInteger(value, field, 2_147_483_647);
}

function boundedPositiveInteger(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new BadRequestException(`${field} must be a positive integer up to ${maximum}`);
  }
  return value;
}

function canonicalCost(value: unknown) {
  if (typeof value !== 'string' || value.split('.')[0].length > 30) {
    throw new BadRequestException('costErtExact must be a canonical positive ERT decimal string');
  }
  try {
    return canonicalErt(parseUnsignedErtDecimal(value, 'costErtExact', false));
  } catch {
    throw new BadRequestException('costErtExact must be a canonical positive ERT decimal string');
  }
}

function uuid(value: unknown, field: string) {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID v4`);
  }
  return value.toLowerCase();
}

function postgresCode(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BadRequestException(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Persisted ${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Persisted ${field} must be a non-negative safe integer`);
  }
  return value;
}

function exactInteger(value: unknown, field: string) {
  const stringValue = typeof value === 'number' ? String(value) : value;
  if (typeof stringValue !== 'string' || !/^(0|[1-9][0-9]*)$/.test(stringValue)) {
    throw new Error(`Persisted ${field} must be an exact non-negative integer`);
  }
  return stringValue;
}

function exactErt(value: unknown) {
  if (typeof value !== 'string') throw new Error('Persisted Raffle v2 ERT must be exact');
  return canonicalErt(parseUnsignedErtDecimal(value, 'raffle v2 admin cost', false));
}

function updateRows<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return Array.isArray(value[0]) ? value[0] as T[] : value as T[];
}

function iso(value: unknown) {
  const timestamp = value instanceof Date
    ? value
    : typeof value === 'string' || typeof value === 'number'
      ? new Date(value)
      : null;
  if (timestamp === null || Number.isNaN(timestamp.valueOf())) throw new Error('Persisted timestamp is invalid');
  return timestamp.toISOString();
}
