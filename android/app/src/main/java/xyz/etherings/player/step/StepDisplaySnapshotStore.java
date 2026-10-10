package xyz.etherings.player.step;

import android.content.Context;
import android.content.SharedPreferences;

import java.time.LocalDate;

public final class StepDisplaySnapshotStore {
    private static final String PREFS_NAME = "etherings_room_step_display_v1";
    private static final String OWNER_ID = "owner_id";
    private static final String TOTAL_STEPS = "total_steps";
    private static final String DAILY_STEPS = "daily_steps";
    private static final String REWARD_WINDOW_STEPS = "reward_window_steps";
    private static final String REWARD_WINDOW_STARTED_AT_MS = "reward_window_started_at_ms";
    private static final String LAST_RAW_COUNTER = "last_raw_counter";
    private static final String EVENT_COUNT = "event_count";
    private static final String LAST_SENSOR_UPDATE_AT_MS = "last_sensor_update_at_ms";
    private static final String DAILY_DATE = "daily_date";
    private static final String SNAPSHOT_REVISION = "snapshot_revision";
    private static final String CAP_OWNER_ID = "cap_owner_id";
    private static final String SERVER_DAILY_STEP_CAP = "server_daily_step_cap";
    private static final String SERVER_DAILY_STEP_CAP_DATE = "server_daily_step_cap_date";

    private final SharedPreferences preferences;
    private SharedPreferences.OnSharedPreferenceChangeListener preferenceListener;
    private SharedPreferences.OnSharedPreferenceChangeListener capPreferenceListener;

    public StepDisplaySnapshotStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public void save(String ownerId, StepCounterSnapshot snapshot) {
        if (ownerId == null || ownerId.trim().isEmpty() || snapshot == null) {
            throw new IllegalArgumentException("ownerId and snapshot are required");
        }
        preferences.edit()
                .putString(OWNER_ID, ownerId)
                .putLong(TOTAL_STEPS, snapshot.totalSteps())
                .putLong(DAILY_STEPS, snapshot.dailySteps())
                .putLong(REWARD_WINDOW_STEPS, snapshot.rewardWindowSteps())
                .putLong(REWARD_WINDOW_STARTED_AT_MS, snapshot.rewardWindowStartedAtMs())
                .putLong(LAST_RAW_COUNTER, snapshot.lastRawCounter())
                .putInt(EVENT_COUNT, snapshot.eventCount())
                .putLong(LAST_SENSOR_UPDATE_AT_MS, snapshot.lastSensorUpdateAtMs())
                .putString(DAILY_DATE, snapshot.dailyDate())
                .putLong(SNAPSHOT_REVISION, preferences.getLong(SNAPSHOT_REVISION, 0L) + 1L)
                .apply();
    }

    public void startListening(Runnable listener) {
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        stopListening();
        preferenceListener = (sharedPreferences, key) -> {
            if (SNAPSHOT_REVISION.equals(key)) {
                listener.run();
            }
        };
        preferences.registerOnSharedPreferenceChangeListener(preferenceListener);
    }

    public void stopListening() {
        if (preferenceListener == null) {
            return;
        }
        preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener);
        preferenceListener = null;
    }

    public void startCapListening(Runnable listener) {
        if (listener == null) throw new IllegalArgumentException("listener is required");
        stopCapListening();
        capPreferenceListener = (sharedPreferences, key) -> {
            if (SERVER_DAILY_STEP_CAP.equals(key) || CAP_OWNER_ID.equals(key) ||
                    SERVER_DAILY_STEP_CAP_DATE.equals(key)) listener.run();
        };
        preferences.registerOnSharedPreferenceChangeListener(capPreferenceListener);
    }

    public void stopCapListening() {
        if (capPreferenceListener == null) return;
        preferences.unregisterOnSharedPreferenceChangeListener(capPreferenceListener);
        capPreferenceListener = null;
    }

    public void saveServerDailyStepCap(String ownerId, Integer dailyStepCap) {
        saveServerDailyStepCap(ownerId, null, dailyStepCap);
    }

    public void saveServerDailyStepCap(String ownerId, String date, Integer dailyStepCap) {
        if (ownerId == null || ownerId.trim().isEmpty()) {
            throw new IllegalArgumentException("ownerId is required");
        }
        SharedPreferences.Editor editor = preferences.edit().putString(CAP_OWNER_ID, ownerId);
        if (date == null) editor.remove(SERVER_DAILY_STEP_CAP_DATE);
        else editor.putString(SERVER_DAILY_STEP_CAP_DATE, date);
        if (dailyStepCap == null) {
            editor.remove(SERVER_DAILY_STEP_CAP).apply();
            return;
        }
        if (dailyStepCap <= 0) {
            throw new IllegalArgumentException("dailyStepCap must be positive");
        }
        editor.putInt(SERVER_DAILY_STEP_CAP, dailyStepCap).apply();
    }

    public Integer serverDailyStepCap(String ownerId) {
        if (ownerId == null
                || !ownerId.equals(preferences.getString(CAP_OWNER_ID, null))
                || !preferences.contains(SERVER_DAILY_STEP_CAP)) {
            return null;
        }
        String date = preferences.getString(SERVER_DAILY_STEP_CAP_DATE, null);
        if (date != null && !date.equals(LocalDate.now().toString())) return null;
        int value = preferences.getInt(SERVER_DAILY_STEP_CAP, 0);
        return value > 0 ? value : null;
    }

    public StepCounterSnapshot snapshot(String ownerId) {
        if (ownerId == null || !ownerId.equals(preferences.getString(OWNER_ID, null))) {
            return emptySnapshot();
        }
        return new StepCounterSnapshot(
                preferences.getLong(TOTAL_STEPS, 0L),
                preferences.getLong(DAILY_STEPS, 0L),
                preferences.getLong(REWARD_WINDOW_STEPS, 0L),
                preferences.getLong(REWARD_WINDOW_STARTED_AT_MS, 0L),
                preferences.getLong(LAST_RAW_COUNTER, 0L),
                preferences.getInt(EVENT_COUNT, 0),
                preferences.getLong(LAST_SENSOR_UPDATE_AT_MS, 0L),
                preferences.getString(DAILY_DATE, "")
        );
    }

    public StepCounterSnapshot emptySnapshot() {
        return new StepCounterSnapshot(0L, 0L, 0L, 0L, 0L, 0, 0L, "");
    }
}
