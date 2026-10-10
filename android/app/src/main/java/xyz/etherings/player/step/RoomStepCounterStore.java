package xyz.etherings.player.step;

import android.os.Looper;

import java.time.Instant;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

import xyz.etherings.player.sync.EtheringsDatabase;
import xyz.etherings.player.sync.StepAccumulatorEntity;
import xyz.etherings.player.sync.StepOutboxBatchEntity;
import xyz.etherings.player.sync.StepSyncDao;
import xyz.etherings.player.sync.SyncBatchState;
import xyz.etherings.player.sync.SyncInstallationEntity;

public final class RoomStepCounterStore {
    static final long BATCH_STEP_THRESHOLD = 100L;
    static final long BATCH_MAX_AGE_MS = 15L * 60L * 1000L;
    static final long MAX_SERVER_BATCH_STEPS = 100_000L;
    static final String SOURCE = "android_step_counter";
    static final String ALGORITHM_VERSION = "room-step-counter-v1";

    private final EtheringsDatabase database;
    private final Runnable afterAccumulatorWriteHook;

    public RoomStepCounterStore(EtheringsDatabase database) {
        this(database, () -> { });
    }

    RoomStepCounterStore(EtheringsDatabase database, Runnable afterAccumulatorWriteHook) {
        this.database = database;
        this.afterAccumulatorWriteHook = afterAccumulatorWriteHook;
    }

    public StepCounterSnapshot recordSensorCounter(String ownerId, float rawCounterValue, long nowMs) {
        assertBackgroundThread();
        String normalizedOwnerId = requireOwnerId(ownerId);
        long rawCounter = Math.max(0L, (long) Math.floor(rawCounterValue));
        ResultHolder holder = new ResultHolder();

        database.runInTransaction(() -> {
            StepSyncDao dao = database.stepSyncDao();
            SyncInstallationEntity installation = requireInstallation(dao);
            TimeClaim time = timeClaim(nowMs);
            StepAccumulatorEntity current = dao.getAccumulator(normalizedOwnerId);
            boolean accumulatorExists = current != null;
            if (!accumulatorExists) {
                current = emptyAccumulator(normalizedOwnerId, time.localDate, nowMs);
            }

            StepOutboxBatchEntity openBatch = closeStaleOpenBatch(dao, normalizedOwnerId, time.localDate, nowMs);
            StepCounterAccumulator.State before = toState(current);
            long previousSensorUpdateAtMs = current.lastSensorUpdateAtMs;
            long comfortBoundaryAtMs = current.comfortBoundaryAtMs;
            StepCounterAccumulator.State next = StepCounterAccumulator.record(before, rawCounter, time.localDate);
            long delta = Math.max(0L, next.totalSteps - before.totalSteps);
            long rewardWindowStartedAtMs = current.rewardWindowStartedAtMs > 0L
                    ? current.rewardWindowStartedAtMs
                    : nowMs;

            applyState(current, next, rewardWindowStartedAtMs, current.sensorEventCount + 1L, nowMs);
            // The first sensor sample after a Ring mutation establishes a new time baseline.
            // Its delta may span both Comfort epochs, so keep it separate from later steps.
            if (comfortBoundaryAtMs > 0L && nowMs > comfortBoundaryAtMs) {
                current.comfortBoundaryAtMs = 0L;
            }
            if (!accumulatorExists) {
                dao.insertAccumulator(current);
            } else {
                dao.updateAccumulator(current);
            }
            afterAccumulatorWriteHook.run();

            if (delta > 0L) {
                long observedStartedAtMs = observationStart(
                        before.dailyDate,
                        previousSensorUpdateAtMs,
                        nowMs,
                        time
                );
                boolean crossesComfortBoundary = comfortBoundaryAtMs > 0L
                        && observedStartedAtMs < comfortBoundaryAtMs
                        && comfortBoundaryAtMs < nowMs;
                if (crossesComfortBoundary && openBatch != null) {
                    requireSingleUpdate(dao.markOpenBatchReady(openBatch.batchId, normalizedOwnerId, nowMs));
                    openBatch = null;
                }
                if (delta > MAX_SERVER_BATCH_STEPS || observedStartedAtMs >= nowMs) {
                    if (openBatch != null) {
                        requireSingleUpdate(dao.markOpenBatchReady(openBatch.batchId, normalizedOwnerId, nowMs));
                    }
                    StepOutboxBatchEntity rejected = newBatch(
                            normalizedOwnerId,
                            installation,
                            time,
                            Math.min(observedStartedAtMs, nowMs),
                            nowMs,
                            delta
                    );
                    rejected.state = SyncBatchState.TERMINAL_REJECTED;
                    rejected.resultCode = delta > MAX_SERVER_BATCH_STEPS
                            ? "LOCAL_STEP_DELTA_TOO_LARGE"
                            : "LOCAL_ZERO_DURATION_INTERVAL";
                    rejected.acceptedStepDelta = 0L;
                    rejected.earnedErtDelta = 0L;
                    dao.insertBatch(rejected);
                    installation.nextSequence += 1L;
                    dao.updateInstallation(installation);
                    holder.snapshot = snapshot(current);
                    return;
                }
                if (openBatch == null) {
                    openBatch = newBatch(
                            normalizedOwnerId,
                            installation,
                            time,
                            observedStartedAtMs,
                            nowMs,
                            delta
                    );
                    dao.insertBatch(openBatch);
                    installation.nextSequence += 1L;
                    dao.updateInstallation(installation);
                } else {
                    openBatch.stepDelta += delta;
                    openBatch.sensorEventCount += 1L;
                    openBatch.observedEndedAtMs = nowMs;
                    openBatch.updatedAtMs = nowMs;
                    int updated = dao.updateOpenBatch(
                            openBatch.batchId,
                            normalizedOwnerId,
                            nowMs,
                            openBatch.stepDelta,
                            openBatch.sensorEventCount,
                            nowMs
                    );
                    if (updated != 1) {
                        throw new IllegalStateException("Open batch changed during sensor transaction");
                    }
                }

                if (crossesComfortBoundary || openBatch.stepDelta >= BATCH_STEP_THRESHOLD
                        || nowMs - openBatch.observedStartedAtMs >= BATCH_MAX_AGE_MS) {
                    requireSingleUpdate(dao.markOpenBatchReady(openBatch.batchId, normalizedOwnerId, nowMs));
                }
            }

            holder.snapshot = snapshot(current);
        });
        return holder.snapshot;
    }

    public StepCounterSnapshot snapshotAndCloseAgedBatch(String ownerId, long nowMs) {
        assertBackgroundThread();
        String normalizedOwnerId = requireOwnerId(ownerId);
        ResultHolder holder = new ResultHolder();
        database.runInTransaction(() -> {
            StepSyncDao dao = database.stepSyncDao();
            requireInstallation(dao);
            TimeClaim time = timeClaim(nowMs);
            closeStaleOpenBatch(dao, normalizedOwnerId, time.localDate, nowMs);
            StepAccumulatorEntity current = dao.getAccumulator(normalizedOwnerId);
            if (current == null) {
                current = emptyAccumulator(normalizedOwnerId, time.localDate, nowMs);
                dao.insertAccumulator(current);
            } else if (!time.localDate.equals(current.dailyDate)) {
                StepCounterAccumulator.State rolled = StepCounterAccumulator.rollDay(toState(current), time.localDate);
                applyState(
                        current,
                        rolled,
                        current.rewardWindowStartedAtMs,
                        current.sensorEventCount,
                        nowMs
                );
                dao.updateAccumulator(current);
            }
            holder.snapshot = snapshot(current);
        });
        return holder.snapshot;
    }

    public int readyBatchCount(String ownerId) {
        assertBackgroundThread();
        return database.stepSyncDao().readyBatchCount(requireOwnerId(ownerId));
    }

    /** Preserve steps observed before a confirmed Ring/Comfort mutation as a separate batch. */
    public void closeOpenBatchAtComfortBoundary(String ownerId, long nowMs) {
        assertBackgroundThread();
        String normalizedOwnerId = requireOwnerId(ownerId);
        database.runInTransaction(() -> {
            StepSyncDao dao = database.stepSyncDao();
            StepOutboxBatchEntity open = dao.getOpenBatch(normalizedOwnerId);
            if (open != null) {
                requireSingleUpdate(dao.markOpenBatchReady(
                        open.batchId, normalizedOwnerId, nowMs));
            }
            StepAccumulatorEntity accumulator = dao.getAccumulator(normalizedOwnerId);
            if (accumulator != null && nowMs > accumulator.lastSensorUpdateAtMs) {
                accumulator.comfortBoundaryAtMs = nowMs;
                dao.updateAccumulator(accumulator);
            }
        });
    }

    private StepOutboxBatchEntity closeStaleOpenBatch(
            StepSyncDao dao,
            String ownerId,
            String localDate,
            long nowMs
    ) {
        StepOutboxBatchEntity openBatch = dao.getOpenBatch(ownerId);
        if (openBatch == null) {
            return null;
        }
        boolean wrongDay = !localDate.equals(openBatch.localDate);
        boolean aged = nowMs - openBatch.observedStartedAtMs >= BATCH_MAX_AGE_MS;
        if (wrongDay || aged) {
            requireSingleUpdate(dao.markOpenBatchReady(openBatch.batchId, ownerId, nowMs));
            return null;
        }
        return openBatch;
    }

    private StepOutboxBatchEntity newBatch(
            String ownerId,
            SyncInstallationEntity installation,
            TimeClaim time,
            long startedAtMs,
            long endedAtMs,
            long delta
    ) {
        return new StepOutboxBatchEntity(
                UUID.randomUUID().toString(),
                ownerId,
                installation.installationId,
                installation.nextSequence,
                time.localDate,
                time.timezoneOffsetMinutes,
                startedAtMs,
                endedAtMs,
                delta,
                1L,
                SOURCE,
                ALGORITHM_VERSION,
                SyncBatchState.OPEN,
                0,
                null,
                null,
                null,
                null,
                endedAtMs,
                endedAtMs
        );
    }

    private long observationStart(String previousDate, long previousUpdateMs, long nowMs, TimeClaim time) {
        if (time.localDate.equals(previousDate) && previousUpdateMs > 0L) {
            // Equal or backwards timestamps cannot prove a walking interval. Reject that
            // delta locally instead of stretching it to midnight and overlapping earlier batches.
            return Math.min(previousUpdateMs, nowMs);
        }
        return time.localDayStartedAtMs;
    }

    private StepAccumulatorEntity emptyAccumulator(String ownerId, String localDate, long nowMs) {
        return new StepAccumulatorEntity(
                ownerId, 0L, 0L, 0L, 0L, false, localDate,
                nowMs, 0L, 0L, nowMs
        );
    }

    private StepCounterAccumulator.State toState(StepAccumulatorEntity entity) {
        return new StepCounterAccumulator.State(
                entity.totalSteps,
                entity.dailySteps,
                entity.rewardWindowSteps,
                entity.lastRawCounter,
                entity.rawCounterInitialized,
                entity.dailyDate
        );
    }

    private void applyState(
            StepAccumulatorEntity entity,
            StepCounterAccumulator.State state,
            long rewardWindowStartedAtMs,
            long eventCount,
            long updatedAtMs
    ) {
        entity.totalSteps = state.totalSteps;
        entity.dailySteps = state.dailySteps;
        entity.rewardWindowSteps = state.rewardWindowSteps;
        entity.lastRawCounter = state.lastRawCounter;
        entity.rawCounterInitialized = state.rawCounterInitialized;
        entity.dailyDate = state.dailyDate;
        entity.rewardWindowStartedAtMs = rewardWindowStartedAtMs;
        entity.sensorEventCount = Math.max(0L, eventCount);
        entity.lastSensorUpdateAtMs = updatedAtMs;
        entity.updatedAtMs = updatedAtMs;
    }

    private StepCounterSnapshot snapshot(StepAccumulatorEntity entity) {
        return new StepCounterSnapshot(
                entity.totalSteps,
                entity.dailySteps,
                entity.rewardWindowSteps,
                entity.rewardWindowStartedAtMs,
                entity.lastRawCounter,
                (int) Math.min(Integer.MAX_VALUE, entity.sensorEventCount),
                entity.lastSensorUpdateAtMs,
                entity.dailyDate
        );
    }

    private SyncInstallationEntity requireInstallation(StepSyncDao dao) {
        SyncInstallationEntity installation = dao.getInstallation();
        if (installation == null) {
            throw new IllegalStateException("Room installation is not initialized");
        }
        return installation;
    }

    private String requireOwnerId(String ownerId) {
        if (ownerId == null) {
            throw new IllegalArgumentException("ownerId is required");
        }
        try {
            return UUID.fromString(ownerId).toString();
        } catch (IllegalArgumentException error) {
            throw new IllegalArgumentException("ownerId must be a UUID", error);
        }
    }

    private TimeClaim timeClaim(long nowMs) {
        ZonedDateTime local = Instant.ofEpochMilli(Math.max(0L, nowMs)).atZone(ZoneId.systemDefault());
        return new TimeClaim(
                local.format(DateTimeFormatter.ISO_LOCAL_DATE),
                local.getOffset().getTotalSeconds() / 60,
                local.toLocalDate().atStartOfDay(local.getZone()).toInstant().toEpochMilli()
        );
    }

    private void requireSingleUpdate(int count) {
        if (count != 1) {
            throw new IllegalStateException("Expected one Room row update, got " + count);
        }
    }

    private void assertBackgroundThread() {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new IllegalStateException("Step Room operations must not run on the main thread");
        }
    }

    private static final class ResultHolder {
        StepCounterSnapshot snapshot;
    }

    private static final class TimeClaim {
        final String localDate;
        final int timezoneOffsetMinutes;
        final long localDayStartedAtMs;

        TimeClaim(String localDate, int timezoneOffsetMinutes, long localDayStartedAtMs) {
            this.localDate = localDate;
            this.timezoneOffsetMinutes = timezoneOffsetMinutes;
            this.localDayStartedAtMs = localDayStartedAtMs;
        }
    }
}
