package xyz.etherings.player.step;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import android.content.Context;

import androidx.room.Room;
import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.time.Instant;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import xyz.etherings.player.sync.EtheringsDatabase;
import xyz.etherings.player.sync.StepAccumulatorEntity;
import xyz.etherings.player.sync.StepOutboxBatchEntity;
import xyz.etherings.player.sync.StepSyncDao;
import xyz.etherings.player.sync.SyncBatchState;
import xyz.etherings.player.sync.SyncInstallationEntity;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RoomStepCounterStoreTest {
    private EtheringsDatabase database;
    private StepSyncDao dao;
    private ExecutorService executor;
    private RoomStepCounterStore store;
    private String ownerId;
    private TimeZone originalTimeZone;

    @Before
    public void setUp() {
        originalTimeZone = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        Context context = ApplicationProvider.getApplicationContext();
        database = Room.inMemoryDatabaseBuilder(context, EtheringsDatabase.class)
                .allowMainThreadQueries()
                .build();
        dao = database.stepSyncDao();
        dao.insertInstallation(new SyncInstallationEntity(1, UUID.randomUUID().toString(), 0L, 1000L));
        executor = Executors.newSingleThreadExecutor();
        store = new RoomStepCounterStore(database);
        ownerId = UUID.randomUUID().toString();
    }

    @After
    public void tearDown() {
        executor.shutdownNow();
        database.close();
        TimeZone.setDefault(originalTimeZone);
    }

    @Test
    public void establishesBaselineAndClosesBatchAtStepThreshold() throws Exception {
        long start = time("2026-08-11T10:00:00Z");
        StepCounterSnapshot baseline = record(store, ownerId, 5000F, start);
        assertEquals(0L, baseline.totalSteps());
        assertNull(dao.getOpenBatch(ownerId));

        record(store, ownerId, 5050F, start + 60_000L);
        StepOutboxBatchEntity open = dao.getOpenBatch(ownerId);
        assertNotNull(open);
        assertEquals(50L, open.stepDelta);
        assertEquals(0L, open.sequence);

        StepCounterSnapshot threshold = record(store, ownerId, 5100F, start + 120_000L);
        assertEquals(100L, threshold.totalSteps());
        assertNull(dao.getOpenBatch(ownerId));
        assertEquals(1, dao.listBatches(ownerId, SyncBatchState.READY, 10).size());
        assertEquals(100L, dao.listBatches(ownerId, SyncBatchState.READY, 10).get(0).stepDelta);
        assertEquals(1L, dao.getInstallation().nextSequence);
    }

    @Test
    public void comfortBoundaryClosesOnlyCurrentOpenBatchAndPreservesQueuedSteps() throws Exception {
        long start = time("2026-08-11T10:00:00Z");
        record(store, ownerId, 100F, start);
        record(store, ownerId, 110F, start + 60_000L);
        executor.submit(() -> store.closeOpenBatchAtComfortBoundary(
                ownerId, start + 61_000L)).get();
        assertNull(dao.getOpenBatch(ownerId));
        assertEquals(10L, dao.listBatches(ownerId, SyncBatchState.READY, 10)
                .get(0).stepDelta);
        record(store, ownerId, 115F, start + 120_000L);
        assertNull(dao.getOpenBatch(ownerId));
        assertEquals(5L, dao.listBatches(ownerId, SyncBatchState.READY, 10).get(1).stepDelta);
        record(store, ownerId, 120F, start + 180_000L);
        assertEquals(5L, dao.getOpenBatch(ownerId).stepDelta);
        assertEquals(start + 120_000L, dao.getOpenBatch(ownerId).observedStartedAtMs);
        assertEquals(10L, dao.listBatches(ownerId, SyncBatchState.READY, 10)
                .get(0).stepDelta);
    }

    @Test
    public void closesAgedBatchBeforePuttingNewDeltaIntoAnotherBatch() throws Exception {
        long start = time("2026-08-11T10:00:00Z");
        record(store, ownerId, 100F, start);
        record(store, ownerId, 110F, start + 60_000L);
        record(store, ownerId, 115F, start + 16L * 60L * 1000L);

        assertNull(dao.getOpenBatch(ownerId));
        assertEquals(2, dao.listBatches(ownerId, SyncBatchState.READY, 10).size());
        assertEquals(10L, dao.listBatches(ownerId, SyncBatchState.READY, 10).get(0).stepDelta);
        assertEquals(5L, dao.listBatches(ownerId, SyncBatchState.READY, 10).get(1).stepDelta);
        assertEquals(1L, dao.listBatches(ownerId, SyncBatchState.READY, 10).get(1).sequence);
    }

    @Test
    public void sameMillisecondAfterClosedBatchDoesNotCreateMidnightOverlap() throws Exception {
        long start = time("2026-08-11T10:00:00Z");
        record(store, ownerId, 100F, start);
        record(store, ownerId, 200F, start + 60_000L);
        record(store, ownerId, 201F, start + 60_000L);

        assertEquals(1, dao.listBatches(ownerId, SyncBatchState.READY, 10).size());
        StepOutboxBatchEntity rejected = dao.listBatches(ownerId,
                SyncBatchState.TERMINAL_REJECTED, 10).get(0);
        assertEquals("LOCAL_ZERO_DURATION_INTERVAL", rejected.resultCode);
        assertEquals(start + 60_000L, rejected.observedStartedAtMs);

        record(store, ownerId, 202F, start + 61_000L);
        assertEquals(start + 60_000L, dao.getOpenBatch(ownerId).observedStartedAtMs);
        assertEquals(1L, dao.getOpenBatch(ownerId).stepDelta);
    }

    @Test
    public void dayRolloverClosesYesterdayAndStartsOwnerBoundTodayBatch() throws Exception {
        long beforeMidnight = time("2026-08-11T23:58:00Z");
        record(store, ownerId, 100F, beforeMidnight);
        record(store, ownerId, 110F, beforeMidnight + 60_000L);
        StepCounterSnapshot today = record(store, ownerId, 120F, time("2026-08-12T00:01:00Z"));

        StepOutboxBatchEntity yesterday = dao.listBatches(ownerId, SyncBatchState.READY, 10).get(0);
        StepOutboxBatchEntity open = dao.getOpenBatch(ownerId);
        assertEquals("2026-08-11", yesterday.localDate);
        assertEquals(10L, yesterday.stepDelta);
        assertNotNull(open);
        assertEquals("2026-08-12", open.localDate);
        assertEquals(10L, open.stepDelta);
        assertEquals(10L, today.dailySteps());
        assertEquals(20L, today.totalSteps());
    }

    @Test
    public void lowerRawCounterAfterRebootPreservesStepsAndOnlyResetsBaseline() throws Exception {
        long start = time("2026-08-11T10:00:00Z");
        record(store, ownerId, 500F, start);
        record(store, ownerId, 550F, start + 60_000L);
        StepCounterSnapshot afterReboot = record(store, ownerId, 20F, start + 120_000L);

        assertEquals(50L, afterReboot.totalSteps());
        assertEquals(50L, dao.getOpenBatch(ownerId).stepDelta);
    }

    @Test
    public void injectedCrashRollsBackRawBaselineAccumulatorAndOutbox() throws Exception {
        long start = time("2026-08-11T10:00:00Z");
        record(store, ownerId, 100F, start);
        RoomStepCounterStore crashingStore = new RoomStepCounterStore(database, () -> {
            throw new IllegalStateException("injected after accumulator write");
        });

        assertThrows(ExecutionException.class, () -> record(crashingStore, ownerId, 110F, start + 60_000L));
        StepAccumulatorEntity afterCrash = dao.getAccumulator(ownerId);
        assertEquals(100L, afterCrash.lastRawCounter);
        assertEquals(0L, afterCrash.totalSteps);
        assertNull(dao.getOpenBatch(ownerId));

        StepCounterSnapshot recovered = record(store, ownerId, 110F, start + 120_000L);
        assertEquals(10L, recovered.totalSteps());
        assertEquals(10L, dao.getOpenBatch(ownerId).stepDelta);
    }

    @Test
    public void accountSwitchCreatesIndependentBaselineAndNeverReusesAnotherQueue() throws Exception {
        String secondOwnerId = UUID.randomUUID().toString();
        long start = time("2026-08-11T10:00:00Z");
        record(store, ownerId, 100F, start);
        record(store, ownerId, 120F, start + 60_000L);
        StepCounterSnapshot secondBaseline = record(store, secondOwnerId, 120F, start + 120_000L);

        assertEquals(0L, secondBaseline.totalSteps());
        assertEquals(20L, dao.getOpenBatch(ownerId).stepDelta);
        assertNull(dao.getOpenBatch(secondOwnerId));
        assertEquals(20L, dao.getAccumulator(ownerId).totalSteps);
        assertEquals(0L, dao.getAccumulator(secondOwnerId).totalSteps);
    }

    @Test
    public void archivesUnsendableLargeDeltaWithoutBlockingLaterBatches() throws Exception {
        long start = time("2026-08-11T10:00:00Z");
        record(store, ownerId, 100F, start);
        StepCounterSnapshot large = record(store, ownerId, 100_101F, start + 60_000L);

        assertEquals(100_001L, large.totalSteps());
        assertNull(dao.getOpenBatch(ownerId));
        StepOutboxBatchEntity rejected = dao.listBatches(
                ownerId,
                SyncBatchState.TERMINAL_REJECTED,
                10
        ).get(0);
        assertEquals("LOCAL_STEP_DELTA_TOO_LARGE", rejected.resultCode);
        assertEquals(0L, rejected.acceptedStepDelta.longValue());

        record(store, ownerId, 100_111F, start + 120_000L);
        assertEquals(10L, dao.getOpenBatch(ownerId).stepDelta);
        assertEquals(1L, dao.getOpenBatch(ownerId).sequence);
    }

    @Test
    public void rejectsMainThreadAndNonUuidOwner() {
        assertThrows(
                IllegalStateException.class,
                () -> store.recordSensorCounter(ownerId, 100F, System.currentTimeMillis())
        );
        assertThrows(
                ExecutionException.class,
                () -> record(store, "legacy:unclaimed", 100F, System.currentTimeMillis())
        );
    }

    private StepCounterSnapshot record(
            RoomStepCounterStore target,
            String targetOwnerId,
            float raw,
            long nowMs
    ) throws Exception {
        return executor.submit(() -> target.recordSensorCounter(targetOwnerId, raw, nowMs)).get();
    }

    private long time(String iso) {
        return Instant.parse(iso).toEpochMilli();
    }
}
