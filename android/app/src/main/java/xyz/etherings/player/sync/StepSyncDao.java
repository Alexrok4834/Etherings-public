package xyz.etherings.player.sync;

import androidx.annotation.Nullable;
import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;
import androidx.room.Transaction;
import androidx.room.Update;

import java.util.List;

@Dao
public interface StepSyncDao {
    @Query("SELECT * FROM sync_installation WHERE id = 1 LIMIT 1")
    @Nullable
    SyncInstallationEntity getInstallation();

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insertInstallation(SyncInstallationEntity installation);

    @Update
    int updateInstallation(SyncInstallationEntity installation);

    @Query("SELECT * FROM step_accumulator WHERE owner_id = :ownerId LIMIT 1")
    @Nullable
    StepAccumulatorEntity getAccumulator(String ownerId);

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insertAccumulator(StepAccumulatorEntity accumulator);

    @Update
    int updateAccumulator(StepAccumulatorEntity accumulator);

    @Query("SELECT * FROM step_outbox_batch WHERE batch_id = :batchId LIMIT 1")
    @Nullable
    StepOutboxBatchEntity getBatch(String batchId);

    @Query("SELECT * FROM step_outbox_batch WHERE owner_id = :ownerId AND state = :state ORDER BY sequence ASC LIMIT :limit")
    List<StepOutboxBatchEntity> listBatches(String ownerId, SyncBatchState state, int limit);

    @Query("SELECT * FROM step_outbox_batch WHERE owner_id = :ownerId AND installation_id = :installationId AND state IN ('READY', 'IN_FLIGHT') ORDER BY sequence ASC LIMIT 1")
    @Nullable
    StepOutboxBatchEntity getOldestUnresolvedBatch(String ownerId, String installationId);

    @Query("SELECT COUNT(*) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'READY'")
    int readyBatchCount(String ownerId);

    @Query("SELECT * FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'OPEN' LIMIT 1")
    @Nullable
    StepOutboxBatchEntity getOpenBatch(String ownerId);

    @Query("SELECT COALESCE(SUM(step_delta), 0) FROM step_outbox_batch WHERE owner_id = :ownerId AND state IN ('READY', 'IN_FLIGHT', 'HELD')")
    long pendingStepCount(String ownerId);

    @Query("SELECT COUNT(*) FROM step_outbox_batch WHERE owner_id = :ownerId AND state IN ('READY', 'IN_FLIGHT', 'HELD')")
    int pendingBatchCount(String ownerId);

    @Query("SELECT COALESCE(SUM(step_delta), 0) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'HELD'")
    long heldStepCount(String ownerId);

    @Query("SELECT COUNT(*) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'HELD'")
    int heldBatchCount(String ownerId);

    @Query("SELECT COUNT(*) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'ACKED'")
    int syncedBatchCount(String ownerId);

    @Query("SELECT COALESCE(SUM(accepted_step_delta), 0) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'ACKED'")
    long syncedStepCount(String ownerId);

    @Query("SELECT COALESCE(earned_ert_delta_exact, CAST(earned_ert_delta AS TEXT)) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'ACKED' AND (earned_ert_delta_exact IS NOT NULL OR earned_ert_delta IS NOT NULL) ORDER BY sequence ASC")
    List<String> syncedErtExactValues(String ownerId);

    @Query("SELECT COUNT(*) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'TERMINAL_REJECTED'")
    int rejectedBatchCount(String ownerId);

    @Query("SELECT COALESCE(SUM(step_delta), 0) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'TERMINAL_REJECTED'")
    long rejectedStepCount(String ownerId);

    @Query("SELECT COALESCE(MAX(updated_at_ms), 0) FROM step_outbox_batch WHERE owner_id = :ownerId AND state = 'ACKED'")
    long lastSuccessfulSyncAtMs(String ownerId);

    @Insert(onConflict = OnConflictStrategy.ABORT)
    void insertBatch(StepOutboxBatchEntity batch);

    @Query("UPDATE step_outbox_batch SET observed_ended_at_ms = :endedAtMs, step_delta = :stepDelta, sensor_event_count = :sensorEventCount, updated_at_ms = :updatedAtMs WHERE batch_id = :batchId AND owner_id = :ownerId AND state = 'OPEN'")
    int updateOpenBatch(
            String batchId,
            String ownerId,
            long endedAtMs,
            long stepDelta,
            long sensorEventCount,
            long updatedAtMs
    );

    @Query("UPDATE step_outbox_batch SET state = 'READY', updated_at_ms = :updatedAtMs WHERE batch_id = :batchId AND owner_id = :ownerId AND state = 'OPEN'")
    int markOpenBatchReady(String batchId, String ownerId, long updatedAtMs);

    @Query("UPDATE step_outbox_batch SET state = 'IN_FLIGHT', attempt_count = attempt_count + 1, last_attempt_at_ms = :attemptAtMs, updated_at_ms = :attemptAtMs WHERE batch_id = :batchId AND owner_id = :ownerId AND state = 'READY'")
    int markReadyBatchInFlight(String batchId, String ownerId, long attemptAtMs);

    @Query("UPDATE step_outbox_batch SET state = 'READY', updated_at_ms = :updatedAtMs WHERE batch_id = :batchId AND owner_id = :ownerId AND state = 'IN_FLIGHT'")
    int returnInFlightBatchToReady(String batchId, String ownerId, long updatedAtMs);

    @Query("UPDATE step_outbox_batch SET state = 'HELD', result_code = :reason, updated_at_ms = :updatedAtMs WHERE batch_id = :batchId AND owner_id = :ownerId AND state = 'IN_FLIGHT'")
    int holdInFlightBatch(String batchId, String ownerId, String reason, long updatedAtMs);

    @Query("UPDATE step_outbox_batch SET state = 'READY', updated_at_ms = :updatedAtMs WHERE owner_id = :ownerId AND installation_id = :installationId AND state = 'IN_FLIGHT' AND last_attempt_at_ms <= :staleBeforeMs")
    int recoverStaleInFlightBatches(String ownerId, String installationId, long staleBeforeMs, long updatedAtMs);

    @Query("UPDATE step_outbox_batch SET state = 'ACKED', result_code = :resultCode, accepted_step_delta = :acceptedStepDelta, earned_ert_delta = :earnedErtDelta, earned_ert_delta_exact = :earnedErtDeltaExact, earned_ert_delta_display = :earnedErtDeltaDisplay, updated_at_ms = :updatedAtMs WHERE batch_id = :batchId AND owner_id = :ownerId AND state = 'IN_FLIGHT'")
    int acknowledgeInFlightBatch(
            String batchId,
            String ownerId,
            String resultCode,
            long acceptedStepDelta,
            long earnedErtDelta,
            String earnedErtDeltaExact,
            String earnedErtDeltaDisplay,
            long updatedAtMs
    );

    @Query("UPDATE step_outbox_batch SET state = 'TERMINAL_REJECTED', result_code = :resultCode, accepted_step_delta = :acceptedStepDelta, earned_ert_delta = :earnedErtDelta, earned_ert_delta_exact = :earnedErtDeltaExact, earned_ert_delta_display = :earnedErtDeltaDisplay, updated_at_ms = :updatedAtMs WHERE batch_id = :batchId AND owner_id = :ownerId AND state = 'IN_FLIGHT'")
    int rejectInFlightBatch(
            String batchId,
            String ownerId,
            String resultCode,
            long acceptedStepDelta,
            long earnedErtDelta,
            String earnedErtDeltaExact,
            String earnedErtDeltaDisplay,
            long updatedAtMs
    );

    @Transaction
    @Nullable
    default StepOutboxBatchEntity claimOldestReadyBatch(String ownerId, String installationId, long attemptAtMs) {
        StepOutboxBatchEntity batch = getOldestUnresolvedBatch(ownerId, installationId);
        if (batch == null || batch.state != SyncBatchState.READY) {
            return null;
        }
        return markReadyBatchInFlight(batch.batchId, ownerId, attemptAtMs) == 1 ? batch : null;
    }

    @Query("SELECT COUNT(*) FROM local_migration_marker WHERE name = :name")
    int migrationMarkerCount(String name);

    @Query("SELECT * FROM local_migration_marker WHERE name = :name LIMIT 1")
    @Nullable
    LocalMigrationMarkerEntity getMigrationMarker(String name);

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insertMigrationMarker(LocalMigrationMarkerEntity marker);

    @Transaction
    default boolean bootstrap(
            SyncInstallationEntity installation,
            @Nullable StepAccumulatorEntity legacyAccumulator,
            LocalMigrationMarkerEntity marker
    ) {
        insertInstallation(installation);
        if (migrationMarkerCount(marker.name) > 0) {
            return false;
        }
        if (legacyAccumulator != null) {
            insertAccumulator(legacyAccumulator);
        }
        insertMigrationMarker(marker);
        return true;
    }

    @Transaction
    default boolean recoverLegacyWindow(
            String legacyOwnerId,
            LocalMigrationMarkerEntity marker,
            @Nullable StepOutboxBatchEntity recoveryBatch
    ) {
        return recoverLegacyWindow(legacyOwnerId, marker, recoveryBatch, () -> { });
    }

    @Transaction
    default boolean recoverLegacyWindow(
            String legacyOwnerId,
            LocalMigrationMarkerEntity marker,
            @Nullable StepOutboxBatchEntity recoveryBatch,
            Runnable afterBatchInsertHook
    ) {
        if (migrationMarkerCount(marker.name) > 0) {
            return false;
        }

        StepAccumulatorEntity legacy = getAccumulator(legacyOwnerId);
        if (legacy != null && legacy.rewardWindowSteps > 0L) {
            if (recoveryBatch == null || recoveryBatch.stepDelta != legacy.rewardWindowSteps) {
                throw new IllegalStateException("Legacy recovery batch does not match the imported window");
            }
            SyncInstallationEntity installation = getInstallation();
            if (installation == null
                    || !installation.installationId.equals(recoveryBatch.installationId)
                    || installation.nextSequence != recoveryBatch.sequence) {
                throw new IllegalStateException("Legacy recovery installation changed");
            }

            insertBatch(recoveryBatch);
            afterBatchInsertHook.run();
            installation.nextSequence += 1L;
            if (updateInstallation(installation) != 1) {
                throw new IllegalStateException("Legacy recovery could not advance installation sequence");
            }
            legacy.rewardWindowSteps = 0L;
            legacy.updatedAtMs = marker.completedAtMs;
            if (updateAccumulator(legacy) != 1) {
                throw new IllegalStateException("Legacy recovery could not retire imported window");
            }
        }

        if (insertMigrationMarker(marker) == -1L) {
            throw new IllegalStateException("Legacy recovery marker already exists");
        }
        return true;
    }
}
