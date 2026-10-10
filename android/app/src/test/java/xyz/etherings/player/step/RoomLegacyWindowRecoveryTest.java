package xyz.etherings.player.step;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.room.Room;
import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import xyz.etherings.player.sync.EtheringsDatabase;
import xyz.etherings.player.sync.LocalMigrationMarkerEntity;
import xyz.etherings.player.sync.StepAccumulatorEntity;
import xyz.etherings.player.sync.StepOutboxBatchEntity;
import xyz.etherings.player.sync.StepSyncDao;
import xyz.etherings.player.sync.SyncBatchState;
import xyz.etherings.player.sync.SyncInstallationEntity;
import xyz.etherings.player.walk.PendingWalkSubmissionStore;
import xyz.etherings.player.walk.WalkSubmissionDraft;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RoomLegacyWindowRecoveryTest {
    private static final String OWNER_ID = "11111111-1111-4111-8111-111111111111";
    private Context context;
    private SharedPreferences stepPreferences;
    private PendingWalkSubmissionStore pendingStore;
    private EtheringsDatabase database;
    private ExecutorService executor;
    private long startMs;
    private long endMs;
    private long nowMs;
    private String localDate;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        stepPreferences = context.getSharedPreferences(StepCounterStore.PREFS_NAME, Context.MODE_PRIVATE);
        stepPreferences.edit().clear().commit();
        pendingStore = new PendingWalkSubmissionStore(context);
        pendingStore.clear();
        database = Room.inMemoryDatabaseBuilder(context, EtheringsDatabase.class)
                .allowMainThreadQueries()
                .build();
        executor = Executors.newSingleThreadExecutor();
        LocalDate today = LocalDate.now(ZoneId.systemDefault());
        startMs = today.atTime(10, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
        endMs = today.atTime(11, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
        nowMs = today.atTime(12, 0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli();
        localDate = today.toString();
    }

    @After
    public void tearDown() {
        executor.shutdownNow();
        database.close();
        stepPreferences.edit().clear().commit();
        pendingStore.clear();
    }

    @Test
    public void migratesVerifiedSingleDayWindowExactlyOnce() throws Exception {
        String installationId = importLegacyWindow(178L, startMs, endMs);
        RoomLegacyWindowRecovery recovery = recovery(() -> OWNER_ID);

        assertEquals(
                RoomLegacyWindowRecovery.Outcome.MIGRATED,
                runRecovery(recovery, OWNER_ID, installationId, nowMs)
        );
        assertEquals(
                RoomLegacyWindowRecovery.Outcome.ALREADY_PROCESSED,
                runRecovery(recovery, OWNER_ID, installationId, nowMs + 1000L)
        );

        StepSyncDao dao = database.stepSyncDao();
        StepOutboxBatchEntity batch = dao.listBatches(OWNER_ID, SyncBatchState.READY, 10).get(0);
        assertEquals(178L, batch.stepDelta);
        assertEquals(localDate, batch.localDate);
        assertEquals(RoomLegacyWindowRecovery.ALGORITHM_VERSION, batch.algorithmVersion);
        assertEquals(0L, dao.getAccumulator(StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID).rewardWindowSteps);
        assertEquals(1, dao.migrationMarkerCount(RoomLegacyWindowRecovery.MIGRATION_NAME));
        assertEquals(1, dao.listBatches(OWNER_ID, SyncBatchState.READY, 10).size());
    }

    @Test
    public void defersOwnerMismatchWithoutConsumingAnotherAccountsWindow() throws Exception {
        String installationId = importLegacyWindow(200L, startMs, endMs);
        String legacyOwnerId = "22222222-2222-4222-8222-222222222222";
        RoomLegacyWindowRecovery recovery = recovery(() -> legacyOwnerId);

        assertEquals(
                RoomLegacyWindowRecovery.Outcome.OWNER_MISMATCH_DEFERRED,
                runRecovery(recovery, OWNER_ID, installationId, nowMs)
        );

        StepSyncDao dao = database.stepSyncDao();
        assertEquals(0, dao.readyBatchCount(OWNER_ID));
        assertEquals(0, dao.listBatches(
                StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID, SyncBatchState.TERMINAL_REJECTED, 10
        ).size());
        assertEquals(200L, dao.getAccumulator(StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID).rewardWindowSteps);
        assertEquals(0, dao.migrationMarkerCount(RoomLegacyWindowRecovery.MIGRATION_NAME));

        assertEquals(
                RoomLegacyWindowRecovery.Outcome.MIGRATED,
                runRecovery(recovery, legacyOwnerId, installationId, nowMs + 1000L)
        );
        assertEquals(1, dao.readyBatchCount(legacyOwnerId));
    }

    @Test
    public void archivesExpiredWindowWithoutGuessingItsDate() throws Exception {
        long expiredStart = nowMs - RoomLegacyWindowRecovery.RETENTION_MS - 1L;
        String installationId = importLegacyWindow(300L, expiredStart, endMs);

        assertEquals(
                RoomLegacyWindowRecovery.Outcome.TERMINALLY_ARCHIVED,
                runRecovery(recovery(() -> OWNER_ID), OWNER_ID, installationId, nowMs)
        );

        StepOutboxBatchEntity archived = database.stepSyncDao().listBatches(
                StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID,
                SyncBatchState.TERMINAL_REJECTED,
                10
        ).get(0);
        assertEquals("LEGACY_WINDOW_EXPIRED", archived.resultCode);
    }

    @Test
    public void archivesWindowThatMayAlreadyHaveARewardingServerSession() throws Exception {
        String installationId = importLegacyWindow(214L, startMs, endMs);
        pendingStore.save(new WalkSubmissionDraft(
                UUID.randomUUID().toString(),
                UUID.randomUUID().toString(),
                startMs,
                endMs,
                1000L,
                214L,
                214L,
                20,
                WalkSubmissionDraft.ALGORITHM_VERSION,
                WalkSubmissionDraft.STATE_FINISH_PENDING,
                null
        ));

        assertEquals(
                RoomLegacyWindowRecovery.Outcome.TERMINALLY_ARCHIVED,
                runRecovery(recovery(() -> OWNER_ID), OWNER_ID, installationId, nowMs)
        );
        StepOutboxBatchEntity archived = database.stepSyncDao().listBatches(
                StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID,
                SyncBatchState.TERMINAL_REJECTED,
                10
        ).get(0);
        assertEquals("LEGACY_SERVER_SESSION_EXISTS", archived.resultCode);
    }

    @Test
    public void rollsBackBatchAccumulatorSequenceAndMarkerAfterInjectedCrash() throws Exception {
        String installationId = importLegacyWindow(125L, startMs, endMs);
        StepSyncDao dao = database.stepSyncDao();
        SyncInstallationEntity installation = dao.getInstallation();
        StepOutboxBatchEntity batch = recoveryBatch(installationId, installation.nextSequence, 125L);

        assertThrows(RuntimeException.class, () -> dao.recoverLegacyWindow(
                StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID,
                new LocalMigrationMarkerEntity(RoomLegacyWindowRecovery.MIGRATION_NAME, 1, nowMs),
                batch,
                () -> { throw new RuntimeException("injected crash"); }
        ));

        StepAccumulatorEntity legacy = dao.getAccumulator(StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID);
        assertEquals(125L, legacy.rewardWindowSteps);
        assertEquals(installation.nextSequence, dao.getInstallation().nextSequence);
        assertNull(dao.getBatch(batch.batchId));
        assertEquals(0, dao.migrationMarkerCount(RoomLegacyWindowRecovery.MIGRATION_NAME));
    }

    private String importLegacyWindow(long steps, long startedAtMs, long endedAtMs) throws Exception {
        stepPreferences.edit()
                .putInt(StepCounterStore.SCHEMA_VERSION, 2)
                .putLong(StepCounterStore.TOTAL_STEPS, steps)
                .putLong(StepCounterStore.DAILY_STEPS, steps)
                .putLong(StepCounterStore.REWARD_WINDOW_STEPS, steps)
                .putLong(StepCounterStore.LAST_RAW_COUNTER, 5000L)
                .putBoolean(StepCounterStore.RAW_COUNTER_INITIALIZED, true)
                .putString(StepCounterStore.DAILY_DATE, localDate)
                .putLong(StepCounterStore.REWARD_WINDOW_STARTED_AT_MS, startedAtMs)
                .putInt(StepCounterStore.EVENT_COUNT, 20)
                .putLong(StepCounterStore.LAST_SENSOR_UPDATE_AT_MS, endedAtMs)
                .commit();
        String installationId = UUID.randomUUID().toString();
        Future<?> future = executor.submit(
                () -> StepRoomBootstrapper.bootstrap(context, database, nowMs, installationId)
        );
        future.get();
        return installationId;
    }

    private RoomLegacyWindowRecovery recovery(RoomLegacyWindowRecovery.LegacyOwnerProvider ownerProvider) {
        return new RoomLegacyWindowRecovery(context, database, ownerProvider, pendingStore);
    }

    private RoomLegacyWindowRecovery.Outcome runRecovery(
            RoomLegacyWindowRecovery recovery,
            String ownerId,
            String installationId,
            long atMs
    ) throws Exception {
        Future<RoomLegacyWindowRecovery.Outcome> future = executor.submit(
                () -> recovery.recover(ownerId, installationId, atMs)
        );
        return future.get();
    }

    private StepOutboxBatchEntity recoveryBatch(String installationId, long sequence, long steps) {
        return new StepOutboxBatchEntity(
                UUID.randomUUID().toString(),
                OWNER_ID,
                installationId,
                sequence,
                localDate,
                0,
                startMs,
                endMs,
                steps,
                20L,
                RoomStepCounterStore.SOURCE,
                RoomLegacyWindowRecovery.ALGORITHM_VERSION,
                SyncBatchState.READY,
                0,
                null,
                null,
                null,
                null,
                nowMs,
                nowMs
        );
    }
}
