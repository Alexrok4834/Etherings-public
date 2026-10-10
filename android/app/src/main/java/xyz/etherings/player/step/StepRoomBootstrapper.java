package xyz.etherings.player.step;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Looper;

import java.util.UUID;

import xyz.etherings.player.sync.EtheringsDatabase;
import xyz.etherings.player.sync.LocalMigrationMarkerEntity;
import xyz.etherings.player.sync.StepAccumulatorEntity;
import xyz.etherings.player.sync.StepSyncDao;
import xyz.etherings.player.sync.SyncInstallationEntity;

public final class StepRoomBootstrapper {
    public static final String LEGACY_UNCLAIMED_OWNER_ID = "legacy:unclaimed";
    static final String MIGRATION_NAME = "step_preferences_to_room_v2";
    static final String ROOM_IMPORT_COMPLETED = "room_import_completed";

    private StepRoomBootstrapper() {
    }

    public static BootstrapResult bootstrap(Context context, EtheringsDatabase database, long nowMs) {
        return bootstrap(context, database, nowMs, UUID.randomUUID().toString());
    }

    @SuppressLint("ApplySharedPref")
    static BootstrapResult bootstrap(
            Context context,
            EtheringsDatabase database,
            long nowMs,
            String generatedInstallationId
    ) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new IllegalStateException("Room bootstrap must not run on the main thread");
        }

        Context applicationContext = context.getApplicationContext();
        SharedPreferences preferences = applicationContext.getSharedPreferences(
                StepCounterStore.PREFS_NAME,
                Context.MODE_PRIVATE
        );
        boolean hasLegacyPreferences = preferences.contains(StepCounterStore.SCHEMA_VERSION)
                || preferences.contains(StepCounterStore.TOTAL_STEPS)
                || preferences.contains(StepCounterStore.LAST_RAW_COUNTER);
        StepAccumulatorEntity legacyAccumulator = null;
        int sourceSchemaVersion = preferences.getInt(StepCounterStore.SCHEMA_VERSION, 1);

        if (hasLegacyPreferences) {
            StepCounterSnapshot snapshot = new StepCounterStore(applicationContext).snapshot();
            legacyAccumulator = new StepAccumulatorEntity(
                    LEGACY_UNCLAIMED_OWNER_ID,
                    snapshot.totalSteps(),
                    snapshot.dailySteps(),
                    snapshot.rewardWindowSteps(),
                    snapshot.lastRawCounter(),
                    preferences.getBoolean(StepCounterStore.RAW_COUNTER_INITIALIZED, false),
                    snapshot.dailyDate(),
                    snapshot.rewardWindowStartedAtMs(),
                    snapshot.eventCount(),
                    snapshot.lastSensorUpdateAtMs(),
                    nowMs
            );
        }

        StepSyncDao dao = database.stepSyncDao();
        boolean migrationApplied = dao.bootstrap(
                new SyncInstallationEntity(
                        SyncInstallationEntity.SINGLETON_ID,
                        generatedInstallationId,
                        0L,
                        nowMs
                ),
                legacyAccumulator,
                new LocalMigrationMarkerEntity(MIGRATION_NAME, sourceSchemaVersion, nowMs)
        );
        SyncInstallationEntity installation = dao.getInstallation();
        if (installation == null) {
            throw new IllegalStateException("Room bootstrap did not create installation identity");
        }

        if (migrationApplied) {
            // Room is already authoritative; persist this auxiliary marker before returning.
            preferences.edit().putBoolean(ROOM_IMPORT_COMPLETED, true).commit();
        }
        return new BootstrapResult(installation.installationId, migrationApplied, legacyAccumulator != null);
    }

    public static final class BootstrapResult {
        private final String installationId;
        private final boolean migrationApplied;
        private final boolean legacyStateFound;

        BootstrapResult(String installationId, boolean migrationApplied, boolean legacyStateFound) {
            this.installationId = installationId;
            this.migrationApplied = migrationApplied;
            this.legacyStateFound = legacyStateFound;
        }

        public String installationId() {
            return installationId;
        }

        public boolean migrationApplied() {
            return migrationApplied;
        }

        public boolean legacyStateFound() {
            return legacyStateFound;
        }
    }
}
