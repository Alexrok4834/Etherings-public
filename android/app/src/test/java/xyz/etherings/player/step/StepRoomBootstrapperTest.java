package xyz.etherings.player.step;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

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

import java.util.UUID;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import xyz.etherings.player.sync.EtheringsDatabase;
import xyz.etherings.player.sync.StepAccumulatorEntity;
import xyz.etherings.player.sync.StepSyncDao;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class StepRoomBootstrapperTest {
    private Context context;
    private SharedPreferences preferences;
    private EtheringsDatabase database;
    private ExecutorService executor;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        preferences = context.getSharedPreferences(StepCounterStore.PREFS_NAME, Context.MODE_PRIVATE);
        preferences.edit().clear().commit();
        database = Room.inMemoryDatabaseBuilder(context, EtheringsDatabase.class)
                .allowMainThreadQueries()
                .build();
        executor = Executors.newSingleThreadExecutor();
    }

    @After
    public void tearDown() {
        executor.shutdownNow();
        database.close();
        preferences.edit().clear().commit();
    }

    @Test
    public void importsSchemaV2PreferencesOnceWithoutAssigningThemToAUser() throws Exception {
        preferences.edit()
                .putInt(StepCounterStore.SCHEMA_VERSION, 2)
                .putLong(StepCounterStore.TOTAL_STEPS, 1234L)
                .putLong(StepCounterStore.DAILY_STEPS, 234L)
                .putLong(StepCounterStore.REWARD_WINDOW_STEPS, 178L)
                .putLong(StepCounterStore.LAST_RAW_COUNTER, 9876L)
                .putBoolean(StepCounterStore.RAW_COUNTER_INITIALIZED, true)
                .putString(StepCounterStore.DAILY_DATE, today())
                .putLong(StepCounterStore.REWARD_WINDOW_STARTED_AT_MS, 1000L)
                .putInt(StepCounterStore.EVENT_COUNT, 42)
                .putLong(StepCounterStore.LAST_SENSOR_UPDATE_AT_MS, 2000L)
                .commit();

        String firstInstallationId = UUID.randomUUID().toString();
        StepRoomBootstrapper.BootstrapResult first = runBootstrap(3000L, firstInstallationId);
        StepSyncDao dao = database.stepSyncDao();
        StepAccumulatorEntity imported = dao.getAccumulator(StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID);

        assertTrue(first.migrationApplied());
        assertTrue(first.legacyStateFound());
        assertEquals(firstInstallationId, first.installationId());
        assertNotNull(imported);
        assertEquals(1234L, imported.totalSteps);
        assertEquals(234L, imported.dailySteps);
        assertEquals(178L, imported.rewardWindowSteps);
        assertEquals(9876L, imported.lastRawCounter);
        assertTrue(imported.rawCounterInitialized);
        assertEquals(today(), imported.dailyDate);
        assertEquals(42L, imported.sensorEventCount);
        assertEquals(1, dao.migrationMarkerCount(StepRoomBootstrapper.MIGRATION_NAME));
        assertTrue(preferences.getBoolean(StepRoomBootstrapper.ROOM_IMPORT_COMPLETED, false));

        preferences.edit().putLong(StepCounterStore.TOTAL_STEPS, 9999L).commit();
        StepRoomBootstrapper.BootstrapResult second = runBootstrap(4000L, UUID.randomUUID().toString());
        assertFalse(second.migrationApplied());
        assertEquals(firstInstallationId, second.installationId());
        assertEquals(1234L, dao.getAccumulator(StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID).totalSteps);
        assertEquals(9999L, preferences.getLong(StepCounterStore.TOTAL_STEPS, 0L));
    }

    @Test
    public void createsInstallationAndMarkerWithoutInventingLegacyState() throws Exception {
        StepRoomBootstrapper.BootstrapResult result = runBootstrap(5000L, UUID.randomUUID().toString());

        assertTrue(result.migrationApplied());
        assertFalse(result.legacyStateFound());
        assertNotNull(database.stepSyncDao().getInstallation());
        assertNull(database.stepSyncDao().getAccumulator(StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID));
        assertEquals(1, database.stepSyncDao().migrationMarkerCount(StepRoomBootstrapper.MIGRATION_NAME));
    }

    @Test
    public void upgradesSchemaV1BaselinesBeforeImportAndRecordsTheirOrigin() throws Exception {
        preferences.edit()
                .putLong(StepCounterStore.LAST_RAW_COUNTER, 1000L)
                .putLong(StepCounterStore.LEGACY_TOTAL_BASELINE, 900L)
                .putLong(StepCounterStore.LEGACY_DAILY_BASELINE, 950L)
                .putLong(StepCounterStore.LEGACY_REWARD_WINDOW_BASELINE, 975L)
                .putString(StepCounterStore.DAILY_DATE, today())
                .commit();

        StepRoomBootstrapper.BootstrapResult result = runBootstrap(7000L, UUID.randomUUID().toString());
        StepAccumulatorEntity imported = database.stepSyncDao()
                .getAccumulator(StepRoomBootstrapper.LEGACY_UNCLAIMED_OWNER_ID);

        assertTrue(result.migrationApplied());
        assertNotNull(imported);
        assertEquals(100L, imported.totalSteps);
        assertEquals(50L, imported.dailySteps);
        assertEquals(25L, imported.rewardWindowSteps);
        assertEquals(1, database.stepSyncDao().getMigrationMarker(StepRoomBootstrapper.MIGRATION_NAME).sourceSchemaVersion);
        assertEquals(2, preferences.getInt(StepCounterStore.SCHEMA_VERSION, 0));
    }

    @Test
    public void rejectsBootstrapOnMainThread() {
        assertThrows(
                IllegalStateException.class,
                () -> StepRoomBootstrapper.bootstrap(context, database, 6000L, UUID.randomUUID().toString())
        );
    }

    private StepRoomBootstrapper.BootstrapResult runBootstrap(long nowMs, String installationId) throws Exception {
        Future<StepRoomBootstrapper.BootstrapResult> future = executor.submit(
                () -> StepRoomBootstrapper.bootstrap(context, database, nowMs, installationId)
        );
        return future.get();
    }

    private String today() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }
}
