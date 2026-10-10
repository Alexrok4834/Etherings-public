package xyz.etherings.player.sync;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.ForeignKey;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
        tableName = "step_outbox_batch",
        foreignKeys = {@ForeignKey(
                entity = SyncInstallationEntity.class,
                parentColumns = {"installation_id"},
                childColumns = {"installation_id"},
                onDelete = ForeignKey.RESTRICT,
                onUpdate = ForeignKey.NO_ACTION
        )},
        indices = {
                @Index(value = {"installation_id", "sequence"}, unique = true),
                @Index(value = {"owner_id", "state", "sequence"}),
                @Index(value = {"owner_id", "local_date"})
        }
)
public final class StepOutboxBatchEntity {
    @NonNull
    @PrimaryKey
    @ColumnInfo(name = "batch_id")
    public String batchId;

    @NonNull
    @ColumnInfo(name = "owner_id")
    public String ownerId;

    @NonNull
    @ColumnInfo(name = "installation_id")
    public String installationId;

    public long sequence;

    @NonNull
    @ColumnInfo(name = "local_date")
    public String localDate;

    @ColumnInfo(name = "timezone_offset_minutes")
    public int timezoneOffsetMinutes;

    @ColumnInfo(name = "observed_started_at_ms")
    public long observedStartedAtMs;

    @ColumnInfo(name = "observed_ended_at_ms")
    public long observedEndedAtMs;

    @ColumnInfo(name = "step_delta")
    public long stepDelta;

    @ColumnInfo(name = "sensor_event_count")
    public long sensorEventCount;

    @NonNull
    public String source;

    @NonNull
    @ColumnInfo(name = "algorithm_version")
    public String algorithmVersion;

    @NonNull
    public SyncBatchState state;

    @ColumnInfo(name = "attempt_count")
    public int attemptCount;

    @Nullable
    @ColumnInfo(name = "last_attempt_at_ms")
    public Long lastAttemptAtMs;

    @Nullable
    @ColumnInfo(name = "result_code")
    public String resultCode;

    @Nullable
    @ColumnInfo(name = "accepted_step_delta")
    public Long acceptedStepDelta;

    @Nullable
    @ColumnInfo(name = "earned_ert_delta")
    public Long earnedErtDelta;

    @Nullable
    @ColumnInfo(name = "earned_ert_delta_exact")
    public String earnedErtDeltaExact;

    @Nullable
    @ColumnInfo(name = "earned_ert_delta_display")
    public String earnedErtDeltaDisplay;

    @ColumnInfo(name = "created_at_ms")
    public long createdAtMs;

    @ColumnInfo(name = "updated_at_ms")
    public long updatedAtMs;

    public StepOutboxBatchEntity(
            @NonNull String batchId,
            @NonNull String ownerId,
            @NonNull String installationId,
            long sequence,
            @NonNull String localDate,
            int timezoneOffsetMinutes,
            long observedStartedAtMs,
            long observedEndedAtMs,
            long stepDelta,
            long sensorEventCount,
            @NonNull String source,
            @NonNull String algorithmVersion,
            @NonNull SyncBatchState state,
            int attemptCount,
            @Nullable Long lastAttemptAtMs,
            @Nullable String resultCode,
            @Nullable Long acceptedStepDelta,
            @Nullable Long earnedErtDelta,
            long createdAtMs,
            long updatedAtMs
    ) {
        this.batchId = batchId;
        this.ownerId = ownerId;
        this.installationId = installationId;
        this.sequence = sequence;
        this.localDate = localDate;
        this.timezoneOffsetMinutes = timezoneOffsetMinutes;
        this.observedStartedAtMs = observedStartedAtMs;
        this.observedEndedAtMs = observedEndedAtMs;
        this.stepDelta = stepDelta;
        this.sensorEventCount = sensorEventCount;
        this.source = source;
        this.algorithmVersion = algorithmVersion;
        this.state = state;
        this.attemptCount = attemptCount;
        this.lastAttemptAtMs = lastAttemptAtMs;
        this.resultCode = resultCode;
        this.acceptedStepDelta = acceptedStepDelta;
        this.earnedErtDelta = earnedErtDelta;
        this.earnedErtDeltaExact = null;
        this.earnedErtDeltaDisplay = null;
        this.createdAtMs = createdAtMs;
        this.updatedAtMs = updatedAtMs;
    }
}
