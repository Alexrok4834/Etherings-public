package xyz.etherings.player.sync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.room.Room;
import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.UUID;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RoomSyncStatusPublisherTest {
    private EtheringsDatabase database;
    private StepSyncDao dao;
    private SyncStatusStore statusStore;
    private String ownerId;
    private String installationId;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        database = Room.inMemoryDatabaseBuilder(context, EtheringsDatabase.class)
                .allowMainThreadQueries()
                .build();
        dao = database.stepSyncDao();
        statusStore = new SyncStatusStore(context);
        ownerId = UUID.randomUUID().toString();
        installationId = UUID.randomUUID().toString();
        dao.insertInstallation(new SyncInstallationEntity(1, installationId, 4L, 100L));
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void publishesOwnerScopedQueueAndAccountingMetrics() throws Exception {
        dao.insertBatch(batch(0L, SyncBatchState.READY, 40L, null, null, 200L));
        dao.insertBatch(batch(1L, SyncBatchState.IN_FLIGHT, 10L, null, null, 300L));
        dao.insertBatch(batch(2L, SyncBatchState.ACKED, 80L, 75L, 1L, 500L));
        dao.insertBatch(batch(3L, SyncBatchState.TERMINAL_REJECTED, 25L, 0L, 0L, 400L));
        StepOutboxBatchEntity fractional = batch(4L, SyncBatchState.ACKED, 30L, 25L, 0L, 550L);
        fractional.earnedErtDeltaExact = "0.13065";
        fractional.earnedErtDeltaDisplay = "0.13";
        dao.insertBatch(fractional);
        statusStore.markAttempt(ownerId, true, 450L);

        runOffMain(() -> new RoomSyncStatusPublisher(database, statusStore).publish(ownerId));

        SyncStatusSnapshot snapshot = statusStore.snapshot(ownerId);
        assertEquals(50L, snapshot.pendingSteps());
        assertEquals(2, snapshot.pendingBatches());
        assertEquals(100L, snapshot.syncedSteps());
        assertEquals(1L, snapshot.syncedErt());
        assertEquals("1.13065", snapshot.syncedErtExact());
        assertEquals("1.13", snapshot.syncedErtDisplay());
        assertEquals(2, snapshot.syncedBatches());
        assertEquals(25L, snapshot.rejectedSteps());
        assertEquals(1, snapshot.rejectedBatches());
        assertEquals(550L, snapshot.lastSuccessfulSyncAtMs());
        assertEquals(450L, snapshot.lastAttemptAtMs());
        assertTrue(snapshot.authRequired());

        SyncStatusSnapshot otherOwner = statusStore.snapshot(UUID.randomUUID().toString());
        assertEquals(0L, otherOwner.pendingSteps());
        assertFalse(otherOwner.authRequired());
    }

    private StepOutboxBatchEntity batch(
            long sequence,
            SyncBatchState state,
            long steps,
            Long accepted,
            Long earned,
            long updatedAtMs
    ) {
        return new StepOutboxBatchEntity(
                UUID.randomUUID().toString(), ownerId, installationId, sequence, "2026-08-12", 180,
                100L + sequence, 150L + sequence, steps, 2L, "android_step_counter",
                "room-step-counter-v1", state, 0, null, state.name(), accepted, earned, 100L, updatedAtMs
        );
    }

    private static void runOffMain(Runnable action) throws Exception {
        Thread thread = new Thread(action);
        thread.start();
        thread.join(5_000L);
        assertFalse("background operation timed out", thread.isAlive());
    }
}
