package xyz.etherings.player.step;

import android.content.Context;
import android.os.Looper;

import java.security.GeneralSecurityException;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

import xyz.etherings.player.auth.SessionStore;
import xyz.etherings.player.sync.EtheringsDatabase;
import xyz.etherings.player.sync.LocalMigrationMarkerEntity;
import xyz.etherings.player.sync.StepAccumulatorEntity;
import xyz.etherings.player.sync.StepOutboxBatchEntity;
import xyz.etherings.player.sync.StepSyncDao;
import xyz.etherings.player.sync.SyncBatchState;
import xyz.etherings.player.sync.SyncInstallationEntity;
import xyz.etherings.player.walk.PendingWalkSubmissionStore;
import xyz.etherings.player.walk.WalkSubmissionDraft;

public final class RoomLegacyWindowRecovery {
    static final String MIGRATION_NAME = "legacy_reward_window_recovery_v1";
    static final String ALGORITHM_VERSION = "legacy-step-counter-v2-recovery";
    static final long RETENTION_MS = 7L * 24L * 60L * 60L * 1000L;

    public enum Outcome {
        MIGRATED,
        TERMINALLY_ARCHIVED,
        OWNER_MISMATCH_DEFERRED,
        NO_WINDOW,
        ALREADY_PROCESSED
    }

    private final Context context;
    private final EtheringsDatabase database;
    private final LegacyOwnerProvider legacyOwnerProvider;
    private final PendingWalkSubmissionStore pendingStore;

    public RoomLegacyWindowRecovery(Context context, SessionStore sessionStore) {
        this(
                context.getApplicationContext(),
                EtheringsDatabase.open(context),
                sessionStore::getOwnerId,
                new PendingWalkSubmissionStore(context)
        );
    }

    RoomLegacyWindowRecovery(
            Context context,
            EtheringsDatabase database,
            LegacyOwnerProvider legacyOwnerProvider,
            PendingWalkSubmissionStore pendingStore
    ) {
        this.context = context.getApplicationContext();
        this.database = database;
        this.legacyOwnerProvider = legacyOwnerProvider;
        this.pendingStore = pendingStore;
    }

    public Outcome recover(String authenticatedOwnerId, String authenticatedInstallationId, long nowMs)
            throws GeneralSecurityException {
        assertBackgroundThread();
        String ownerId = requireUuid(authenticatedOwnerId, "authenticatedOwnerId");
        String installationId = requireUuid(authenticatedInstallationId, "authenticatedInstallationId");
        StepRoomBootstrapper.bootstrap(context, database, nowMs);

        StepSyncDao dao = database.stepSyncDao();
        if (dao.migrationMarkerCount(MIGRATION_NAME) > 0) {
            return Outcome.ALREADY_PROCESSED;
        }
        StepAccumulatorEntity legacy = dao.getAccumulator(StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID);
        if (legacy == null || legacy.rewardWindowSteps <= 0L) {
            dao.recoverLegacyWindow(
                    StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID,
                    new LocalMigrationMarkerEntity(MIGRATION_NAME, 1, nowMs),
                    null
            );
            return Outcome.NO_WINDOW;
        }

        SyncInstallationEntity installation = dao.getInstallation();
        if (installation == null || !installation.installationId.equals(installationId)) {
            throw new IllegalStateException("Authenticated installation does not match Room");
        }

        WalkSubmissionDraft pendingDraft = pendingStore.load();
        String legacyOwnerId = normalizedUuidOrNull(legacyOwnerProvider.getLegacyOwnerId());
        if (legacyOwnerId != null && !ownerId.equals(legacyOwnerId)) {
            return Outcome.OWNER_MISMATCH_DEFERRED;
        }
        String terminalReason = legacyOwnerId == null
                ? "LEGACY_OWNER_UNVERIFIED"
                : terminalReason(legacy, pendingDraft, nowMs);
        boolean migrated = terminalReason == null;
        String batchOwnerId = migrated ? ownerId : StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID;
        StepOutboxBatchEntity batch = batch(
                legacy,
                installation,
                batchOwnerId,
                pendingDraft,
                terminalReason,
                nowMs
        );
        boolean applied = dao.recoverLegacyWindow(
                StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID,
                new LocalMigrationMarkerEntity(MIGRATION_NAME, 1, nowMs),
                batch
        );
        if (!applied) {
            return Outcome.ALREADY_PROCESSED;
        }
        return migrated ? Outcome.MIGRATED : Outcome.TERMINALLY_ARCHIVED;
    }

    private String terminalReason(
            StepAccumulatorEntity legacy,
            WalkSubmissionDraft pendingDraft,
            long nowMs
    ) {
        if (pendingDraft != null) {
            if (pendingDraft.backendSessionId() != null) {
                return "LEGACY_SERVER_SESSION_EXISTS";
            }
            String state = pendingDraft.state();
            if (!WalkSubmissionDraft.STATE_START_PENDING.equals(state)
                    && !WalkSubmissionDraft.STATE_FAILED_RETRYABLE.equals(state)) {
                return "LEGACY_SUBMISSION_STATE_AMBIGUOUS";
            }
        }
        if (legacy.rewardWindowSteps > RoomStepCounterStore.MAX_SERVER_BATCH_STEPS) {
            return "LEGACY_STEP_DELTA_TOO_LARGE";
        }
        if (legacy.rewardWindowStartedAtMs <= 0L
                || legacy.lastSensorUpdateAtMs <= legacy.rewardWindowStartedAtMs
                || legacy.lastSensorUpdateAtMs > nowMs) {
            return "LEGACY_INTERVAL_INVALID";
        }
        if (nowMs - legacy.rewardWindowStartedAtMs > RETENTION_MS) {
            return "LEGACY_WINDOW_EXPIRED";
        }
        String startedDate = localDate(legacy.rewardWindowStartedAtMs);
        String endedDate = localDate(legacy.lastSensorUpdateAtMs);
        if (!startedDate.equals(endedDate) || !startedDate.equals(legacy.dailyDate)) {
            return "LEGACY_DATE_ATTRIBUTION_AMBIGUOUS";
        }
        return null;
    }

    private StepOutboxBatchEntity batch(
            StepAccumulatorEntity legacy,
            SyncInstallationEntity installation,
            String ownerId,
            WalkSubmissionDraft pendingDraft,
            String terminalReason,
            long nowMs
    ) {
        long endedAtMs = legacy.lastSensorUpdateAtMs > 0L ? legacy.lastSensorUpdateAtMs : nowMs;
        long startedAtMs = legacy.rewardWindowStartedAtMs > 0L
                ? Math.min(legacy.rewardWindowStartedAtMs, endedAtMs)
                : endedAtMs;
        ZonedDateTime ended = Instant.ofEpochMilli(Math.max(0L, endedAtMs)).atZone(ZoneId.systemDefault());
        String localDate = legacy.dailyDate == null || legacy.dailyDate.trim().isEmpty()
                ? ended.format(DateTimeFormatter.ISO_LOCAL_DATE)
                : legacy.dailyDate;
        String batchId = usableBatchId(pendingDraft);
        SyncBatchState state = terminalReason == null ? SyncBatchState.READY : SyncBatchState.TERMINAL_REJECTED;
        return new StepOutboxBatchEntity(
                batchId,
                ownerId,
                installation.installationId,
                installation.nextSequence,
                localDate,
                ended.getOffset().getTotalSeconds() / 60,
                startedAtMs,
                endedAtMs,
                legacy.rewardWindowSteps,
                Math.max(1L, Math.min(1_000_000L, legacy.sensorEventCount)),
                RoomStepCounterStore.SOURCE,
                ALGORITHM_VERSION,
                state,
                0,
                null,
                terminalReason,
                terminalReason == null ? null : 0L,
                terminalReason == null ? null : 0L,
                nowMs,
                nowMs
        );
    }

    private String usableBatchId(WalkSubmissionDraft pendingDraft) {
        if (pendingDraft != null) {
            try {
                UUID parsed = UUID.fromString(pendingDraft.localSubmissionId());
                if (parsed.version() == 4) {
                    return parsed.toString();
                }
            } catch (IllegalArgumentException ignored) {
                // A malformed legacy ID is not sent; a new v4 ID is protected by the Room marker.
            }
        }
        return UUID.randomUUID().toString();
    }

    private String localDate(long timestampMs) {
        return Instant.ofEpochMilli(Math.max(0L, timestampMs))
                .atZone(ZoneId.systemDefault())
                .format(DateTimeFormatter.ISO_LOCAL_DATE);
    }

    private String requireUuid(String value, String name) {
        if (value == null) {
            throw new IllegalArgumentException(name + " is required");
        }
        try {
            return UUID.fromString(value).toString();
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException(name + " must be a UUID", error);
        }
    }

    private String normalizedUuidOrNull(String value) {
        if (value == null || value.trim().isEmpty()) {
            return null;
        }
        try {
            return UUID.fromString(value).toString();
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    private void assertBackgroundThread() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new IllegalStateException("Legacy recovery must not run on the main thread");
        }
    }

    interface LegacyOwnerProvider {
        String getLegacyOwnerId() throws GeneralSecurityException;
    }
}
