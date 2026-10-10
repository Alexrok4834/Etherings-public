package xyz.etherings.player.sync;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

@Entity(tableName = "step_accumulator")
public final class StepAccumulatorEntity {
    @NonNull
    @PrimaryKey
    @ColumnInfo(name = "owner_id")
    public String ownerId;

    @ColumnInfo(name = "total_steps")
    public long totalSteps;

    @ColumnInfo(name = "daily_steps")
    public long dailySteps;

    @ColumnInfo(name = "reward_window_steps")
    public long rewardWindowSteps;

    @ColumnInfo(name = "last_raw_counter")
    public long lastRawCounter;

    @ColumnInfo(name = "raw_counter_initialized")
    public boolean rawCounterInitialized;

    @NonNull
    @ColumnInfo(name = "daily_date")
    public String dailyDate;

    @ColumnInfo(name = "reward_window_started_at_ms")
    public long rewardWindowStartedAtMs;

    @ColumnInfo(name = "sensor_event_count")
    public long sensorEventCount;

    @ColumnInfo(name = "last_sensor_update_at_ms")
    public long lastSensorUpdateAtMs;

    @ColumnInfo(name = "comfort_boundary_at_ms", defaultValue = "0")
    public long comfortBoundaryAtMs;

    @ColumnInfo(name = "updated_at_ms")
    public long updatedAtMs;

    public StepAccumulatorEntity(
            @NonNull String ownerId,
            long totalSteps,
            long dailySteps,
            long rewardWindowSteps,
            long lastRawCounter,
            boolean rawCounterInitialized,
            @NonNull String dailyDate,
            long rewardWindowStartedAtMs,
            long sensorEventCount,
            long lastSensorUpdateAtMs,
            long updatedAtMs
    ) {
        this.ownerId = ownerId;
        this.totalSteps = totalSteps;
        this.dailySteps = dailySteps;
        this.rewardWindowSteps = rewardWindowSteps;
        this.lastRawCounter = lastRawCounter;
        this.rawCounterInitialized = rawCounterInitialized;
        this.dailyDate = dailyDate;
        this.rewardWindowStartedAtMs = rewardWindowStartedAtMs;
        this.sensorEventCount = sensorEventCount;
        this.lastSensorUpdateAtMs = lastSensorUpdateAtMs;
        this.comfortBoundaryAtMs = 0L;
        this.updatedAtMs = updatedAtMs;
    }
}
