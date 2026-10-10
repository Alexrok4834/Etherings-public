package xyz.etherings.player.step;

import android.content.Context;
import android.content.SharedPreferences;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

public final class StepCounterStore {
    static final int CURRENT_SCHEMA_VERSION = 2;
    static final String PREFS_NAME = "etherings_step_counter_v1";
    static final String SCHEMA_VERSION = "schema_version";
    static final String TOTAL_STEPS = "total_steps_accumulated";
    static final String DAILY_STEPS = "daily_steps_accumulated";
    static final String REWARD_WINDOW_STEPS = "reward_window_steps_accumulated";
    static final String RAW_COUNTER_INITIALIZED = "raw_counter_initialized";
    static final String REWARD_WINDOW_STARTED_AT_MS = "reward_window_started_at_ms";
    static final String DAILY_DATE = "daily_date";
    static final String LAST_RAW_COUNTER = "last_raw_counter";
    static final String EVENT_COUNT = "event_count";
    static final String LAST_SENSOR_UPDATE_AT_MS = "last_sensor_update_at_ms";

    static final String LEGACY_TOTAL_BASELINE = "total_baseline";
    static final String LEGACY_DAILY_BASELINE = "daily_baseline";
    static final String LEGACY_REWARD_WINDOW_BASELINE = "reward_window_baseline";

    private final SharedPreferences preferences;
    private final SimpleDateFormat dayFormat;

    public StepCounterStore(Context context) {
        this.preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.dayFormat = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
        this.dayFormat.setTimeZone(TimeZone.getDefault());
    }

    public synchronized StepCounterSnapshot recordSensorCounter(float rawCounterValue, long nowMs) {
        migrateIfNeeded();
        long rawCounter = Math.max(0L, (long) Math.floor(rawCounterValue));
        String today = dayString(nowMs);
        StepCounterAccumulator.State state = StepCounterAccumulator.record(readState(today), rawCounter, today);
        int eventCount = preferences.getInt(EVENT_COUNT, 0) + 1;
        long rewardStartedAtMs = preferences.getLong(REWARD_WINDOW_STARTED_AT_MS, nowMs);
        if (rewardStartedAtMs <= 0L) {
            rewardStartedAtMs = nowMs;
        }

        writeState(state, preferences.edit())
                .putLong(REWARD_WINDOW_STARTED_AT_MS, rewardStartedAtMs)
                .putInt(EVENT_COUNT, eventCount)
                .putLong(LAST_SENSOR_UPDATE_AT_MS, nowMs)
                .apply();

        return snapshotFrom(state, rewardStartedAtMs, eventCount, nowMs);
    }

    public synchronized StepCounterSnapshot snapshot() {
        migrateIfNeeded();
        String today = dayString(System.currentTimeMillis());
        StepCounterAccumulator.State current = readState(today);
        StepCounterAccumulator.State state = StepCounterAccumulator.rollDay(current, today);
        if (state != current) {
            writeState(state, preferences.edit()).apply();
        }

        return snapshotFrom(
                state,
                preferences.getLong(REWARD_WINDOW_STARTED_AT_MS, 0L),
                preferences.getInt(EVENT_COUNT, 0),
                preferences.getLong(LAST_SENSOR_UPDATE_AT_MS, 0L)
        );
    }

    public synchronized void resetRewardWindow() {
        migrateIfNeeded();
        StepCounterAccumulator.State state = readState(dayString(System.currentTimeMillis())).resetRewardWindow();
        writeState(state, preferences.edit())
                .putLong(REWARD_WINDOW_STARTED_AT_MS, System.currentTimeMillis())
                .apply();
    }

    private void migrateIfNeeded() {
        if (preferences.getInt(SCHEMA_VERSION, 1) >= CURRENT_SCHEMA_VERSION) {
            return;
        }

        long rawCounter = preferences.getLong(LAST_RAW_COUNTER, 0L);
        boolean initialized = preferences.contains(LAST_RAW_COUNTER);
        StepCounterAccumulator.State migrated = StepCounterAccumulator.fromLegacy(
                rawCounter,
                preferences.getLong(LEGACY_TOTAL_BASELINE, rawCounter),
                preferences.getLong(LEGACY_DAILY_BASELINE, rawCounter),
                preferences.getLong(LEGACY_REWARD_WINDOW_BASELINE, rawCounter),
                initialized,
                preferences.getString(DAILY_DATE, dayString(System.currentTimeMillis()))
        );

        writeState(migrated, preferences.edit())
                .putInt(SCHEMA_VERSION, CURRENT_SCHEMA_VERSION)
                .apply();
    }

    private StepCounterAccumulator.State readState(String fallbackDate) {
        return new StepCounterAccumulator.State(
                preferences.getLong(TOTAL_STEPS, 0L),
                preferences.getLong(DAILY_STEPS, 0L),
                preferences.getLong(REWARD_WINDOW_STEPS, 0L),
                preferences.getLong(LAST_RAW_COUNTER, 0L),
                preferences.getBoolean(RAW_COUNTER_INITIALIZED, false),
                preferences.getString(DAILY_DATE, fallbackDate)
        );
    }

    private SharedPreferences.Editor writeState(StepCounterAccumulator.State state, SharedPreferences.Editor editor) {
        return editor
                .putLong(TOTAL_STEPS, state.totalSteps)
                .putLong(DAILY_STEPS, state.dailySteps)
                .putLong(REWARD_WINDOW_STEPS, state.rewardWindowSteps)
                .putLong(LAST_RAW_COUNTER, state.lastRawCounter)
                .putBoolean(RAW_COUNTER_INITIALIZED, state.rawCounterInitialized)
                .putString(DAILY_DATE, state.dailyDate);
    }

    private StepCounterSnapshot snapshotFrom(
            StepCounterAccumulator.State state,
            long rewardStartedAtMs,
            int eventCount,
            long lastUpdate
    ) {
        return new StepCounterSnapshot(
                state.totalSteps,
                state.dailySteps,
                state.rewardWindowSteps,
                rewardStartedAtMs,
                state.lastRawCounter,
                eventCount,
                lastUpdate,
                state.dailyDate
        );
    }

    private String dayString(long nowMs) {
        return dayFormat.format(new Date(Math.max(0L, nowMs)));
    }
}
