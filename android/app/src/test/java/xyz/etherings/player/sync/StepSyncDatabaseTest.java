package xyz.etherings.player.sync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import android.content.Context;
import android.database.Cursor;

import androidx.room.Room;
import androidx.test.core.app.ApplicationProvider;
import androidx.sqlite.db.SupportSQLiteDatabase;
import androidx.sqlite.db.SupportSQLiteOpenHelper;
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.UUID;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class StepSyncDatabaseTest {
    private EtheringsDatabase database;
    private StepSyncDao dao;
    private String installationId;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        database = Room.inMemoryDatabaseBuilder(context, EtheringsDatabase.class)
                .allowMainThreadQueries()
                .build();
        dao = database.stepSyncDao();
        installationId = UUID.randomUUID().toString();
        dao.insertInstallation(new SyncInstallationEntity(1, installationId, 0L, 1000L));
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void scopesAccumulatorAndQueueQueriesByOwner() {
        dao.insertAccumulator(accumulator("user-a", 100L));
        dao.insertAccumulator(accumulator("user-b", 200L));
        dao.insertBatch(batch("user-a", 1L, SyncBatchState.READY));
        dao.insertBatch(batch("user-b", 2L, SyncBatchState.READY));

        assertEquals(100L, dao.getAccumulator("user-a").totalSteps);
        assertEquals(200L, dao.getAccumulator("user-b").totalSteps);
        assertEquals(1, dao.listBatches("user-a", SyncBatchState.READY, 10).size());
        assertEquals("user-a", dao.listBatches("user-a", SyncBatchState.READY, 10).get(0).ownerId);
        assertEquals(10L, dao.pendingStepCount("user-a"));
        assertEquals(10L, dao.pendingStepCount("user-b"));
    }

    @Test
    public void enforcesKnownInstallationAndUniqueSequence() {
        dao.insertBatch(batch("user-a", 1L, SyncBatchState.READY));
        assertThrows(RuntimeException.class, () -> dao.insertBatch(batch("user-a", 1L, SyncBatchState.READY)));

        StepOutboxBatchEntity unknownInstallation = batch("user-a", 2L, SyncBatchState.READY);
        unknownInstallation.installationId = UUID.randomUUID().toString();
        assertThrows(RuntimeException.class, () -> dao.insertBatch(unknownInstallation));
    }

    @Test
    public void rollsBackAccumulatorAndBatchTogetherWhenTransactionFails() {
        assertThrows(IllegalStateException.class, () -> database.runInTransaction(() -> {
            dao.insertAccumulator(accumulator("user-a", 100L));
            dao.insertBatch(batch("user-a", 1L, SyncBatchState.READY));
            throw new IllegalStateException("injected crash");
        }));

        assertNull(dao.getAccumulator("user-a"));
        assertEquals(0, dao.listBatches("user-a", SyncBatchState.READY, 10).size());
    }

    @Test
    public void opensRoomSchemaOnAndroidNine() {
        assertNotNull(database.getOpenHelper().getWritableDatabase());
        assertEquals(4, database.getOpenHelper().getWritableDatabase().getVersion());
    }

    @Test
    public void migrationAddsBoundaryWithoutChangingHeldStepBatch() {
        Context context = ApplicationProvider.getApplicationContext();
        String name = "step-sync-boundary-migration-" + UUID.randomUUID() + ".db";
        SupportSQLiteOpenHelper helper = new FrameworkSQLiteOpenHelperFactory().create(
                SupportSQLiteOpenHelper.Configuration.builder(context)
                        .name(name)
                        .callback(new SupportSQLiteOpenHelper.Callback(3) {
                            @Override
                            public void onCreate(SupportSQLiteDatabase sqlite) {
                                sqlite.execSQL("CREATE TABLE step_accumulator (owner_id TEXT PRIMARY KEY NOT NULL, "
                                        + "last_sensor_update_at_ms INTEGER NOT NULL)");
                                sqlite.execSQL("CREATE TABLE step_outbox_batch (batch_id TEXT PRIMARY KEY NOT NULL, "
                                        + "state TEXT NOT NULL, step_delta INTEGER NOT NULL)");
                            }
                            @Override
                            public void onUpgrade(SupportSQLiteDatabase sqlite, int oldVersion, int newVersion) { }
                        }).build());
        try {
            SupportSQLiteDatabase sqlite = helper.getWritableDatabase();
            sqlite.execSQL("INSERT INTO step_accumulator VALUES ('owner', 1000)");
            sqlite.execSQL("INSERT INTO step_outbox_batch VALUES ('held-batch', 'HELD', 100)");
            EtheringsDatabase.MIGRATION_3_4.migrate(sqlite);
            try (Cursor cursor = sqlite.query("SELECT last_sensor_update_at_ms, comfort_boundary_at_ms "
                    + "FROM step_accumulator WHERE owner_id = 'owner'")) {
                assertEquals(true, cursor.moveToFirst());
                assertEquals(1000L, cursor.getLong(0));
                assertEquals(0L, cursor.getLong(1));
            }
            try (Cursor cursor = sqlite.query("SELECT state, step_delta FROM step_outbox_batch "
                    + "WHERE batch_id = 'held-batch'")) {
                assertEquals(true, cursor.moveToFirst());
                assertEquals("HELD", cursor.getString(0));
                assertEquals(100L, cursor.getLong(1));
            }
        } finally {
            helper.close();
            context.deleteDatabase(name);
        }
    }

    @Test
    public void migrationCopiesVersionOneReceiptWithoutLosingQueueStateOrErt() {
        Context context = ApplicationProvider.getApplicationContext();
        String databaseName = "step-sync-migration-" + UUID.randomUUID() + ".db";
        SupportSQLiteOpenHelper helper = new FrameworkSQLiteOpenHelperFactory().create(
                SupportSQLiteOpenHelper.Configuration.builder(context)
                        .name(databaseName)
                        .callback(new SupportSQLiteOpenHelper.Callback(1) {
                            @Override
                            public void onCreate(SupportSQLiteDatabase database) {
                                database.execSQL(
                                        "CREATE TABLE step_outbox_batch ("
                                                + "batch_id TEXT PRIMARY KEY NOT NULL, state TEXT NOT NULL, "
                                                + "accepted_step_delta INTEGER, earned_ert_delta INTEGER)"
                                );
                            }

                            @Override
                            public void onUpgrade(
                                    SupportSQLiteDatabase database,
                                    int oldVersion,
                                    int newVersion
                            ) {
                            }
                        })
                        .build()
        );
        SupportSQLiteDatabase database = helper.getWritableDatabase();
        database.execSQL(
                "INSERT INTO step_outbox_batch(batch_id, state, accepted_step_delta, earned_ert_delta) "
                        + "VALUES ('batch-1', 'ACKED', 700, 7)"
        );
        database.execSQL(
                "INSERT INTO step_outbox_batch(batch_id, state, accepted_step_delta, earned_ert_delta) "
                        + "VALUES ('batch-2', 'ACKED', 0, 9007199254740993)"
        );
        EtheringsDatabase.MIGRATION_1_2.migrate(database);

        try (Cursor cursor = database.query(
                "SELECT state, accepted_step_delta, earned_ert_delta, "
                        + "earned_ert_delta_exact, earned_ert_delta_display "
                        + "FROM step_outbox_batch WHERE batch_id = 'batch-1'"
        )) {
            assertEquals(true, cursor.moveToFirst());
            assertEquals("ACKED", cursor.getString(0));
            assertEquals(700L, cursor.getLong(1));
            assertEquals(7L, cursor.getLong(2));
            assertEquals("7", cursor.getString(3));
            assertEquals("7.00", cursor.getString(4));
        }
        try (Cursor cursor = database.query(
                "SELECT earned_ert_delta_exact, earned_ert_delta_display "
                        + "FROM step_outbox_batch WHERE batch_id = 'batch-2'"
        )) {
            assertEquals(true, cursor.moveToFirst());
            assertEquals("9007199254740993", cursor.getString(0));
            assertEquals("9007199254740993.00", cursor.getString(1));
        } finally {
            helper.close();
            context.deleteDatabase(databaseName);
        }
    }

    @Test
    public void persistsAccumulatorAndOutboxAcrossDatabaseReopen() {
        Context context = ApplicationProvider.getApplicationContext();
        String databaseName = "step-sync-reopen-" + UUID.randomUUID() + ".db";
        EtheringsDatabase fileDatabase = Room.databaseBuilder(context, EtheringsDatabase.class, databaseName)
                .allowMainThreadQueries()
                .build();
        try {
            StepSyncDao fileDao = fileDatabase.stepSyncDao();
            String fileInstallationId = UUID.randomUUID().toString();
            fileDao.insertInstallation(new SyncInstallationEntity(1, fileInstallationId, 2L, 1000L));
            fileDao.insertAccumulator(accumulator("user-persisted", 321L));
            StepOutboxBatchEntity persistedBatch = batch("user-persisted", 2L, SyncBatchState.READY);
            persistedBatch.installationId = fileInstallationId;
            fileDao.insertBatch(persistedBatch);
            fileDatabase.close();

            fileDatabase = Room.databaseBuilder(context, EtheringsDatabase.class, databaseName)
                    .allowMainThreadQueries()
                    .build();
            StepSyncDao reopenedDao = fileDatabase.stepSyncDao();
            assertEquals(321L, reopenedDao.getAccumulator("user-persisted").totalSteps);
            assertEquals(1, reopenedDao.listBatches("user-persisted", SyncBatchState.READY, 10).size());
            assertEquals(fileInstallationId, reopenedDao.getInstallation().installationId);
        } finally {
            if (fileDatabase.isOpen()) {
                fileDatabase.close();
            }
            context.deleteDatabase(databaseName);
        }
    }

    private StepAccumulatorEntity accumulator(String ownerId, long totalSteps) {
        return new StepAccumulatorEntity(
                ownerId,
                totalSteps,
                totalSteps,
                totalSteps,
                1000L,
                true,
                "2026-08-11",
                1000L,
                1L,
                2000L,
                2000L
        );
    }

    private StepOutboxBatchEntity batch(String ownerId, long sequence, SyncBatchState state) {
        return new StepOutboxBatchEntity(
                UUID.randomUUID().toString(),
                ownerId,
                installationId,
                sequence,
                "2026-08-11",
                180,
                1000L,
                2000L,
                10L,
                1L,
                "android_step_counter",
                "room-scaffold-v1",
                state,
                0,
                null,
                null,
                null,
                null,
                2000L,
                2000L
        );
    }
}
