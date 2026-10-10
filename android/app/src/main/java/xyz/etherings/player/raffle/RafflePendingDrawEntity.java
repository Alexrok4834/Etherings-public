package xyz.etherings.player.raffle;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
        tableName = "raffle_pending_draw",
        indices = {@Index(value = {"idempotency_key"}, unique = true)}
)
public final class RafflePendingDrawEntity {
    @NonNull
    @PrimaryKey
    @ColumnInfo(name = "owner_id")
    public String ownerId;

    @NonNull
    @ColumnInfo(name = "contract_version")
    public String contractVersion;

    @NonNull
    @ColumnInfo(name = "configuration_version")
    public String configurationVersion;

    @NonNull
    @ColumnInfo(name = "idempotency_key")
    public String idempotencyKey;

    @NonNull
    public RafflePendingDrawState state;

    @Nullable
    @ColumnInfo(name = "response_snapshot")
    public String responseSnapshot;

    @Nullable
    @ColumnInfo(name = "terminal_error_code")
    public String terminalErrorCode;

    @ColumnInfo(name = "created_at_ms")
    public long createdAtMs;

    @ColumnInfo(name = "updated_at_ms")
    public long updatedAtMs;

    public RafflePendingDrawEntity(@NonNull String ownerId, @NonNull String contractVersion,
            @NonNull String configurationVersion, @NonNull String idempotencyKey,
            @NonNull RafflePendingDrawState state, @Nullable String responseSnapshot,
            @Nullable String terminalErrorCode, long createdAtMs, long updatedAtMs) {
        this.ownerId = ownerId;
        this.contractVersion = contractVersion;
        this.configurationVersion = configurationVersion;
        this.idempotencyKey = idempotencyKey;
        this.state = state;
        this.responseSnapshot = responseSnapshot;
        this.terminalErrorCode = terminalErrorCode;
        this.createdAtMs = createdAtMs;
        this.updatedAtMs = updatedAtMs;
    }
}
