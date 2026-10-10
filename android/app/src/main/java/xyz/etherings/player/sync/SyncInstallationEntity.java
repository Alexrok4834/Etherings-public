package xyz.etherings.player.sync;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.Index;
import androidx.room.PrimaryKey;

@Entity(
        tableName = "sync_installation",
        indices = {@Index(value = {"installation_id"}, unique = true)}
)
public final class SyncInstallationEntity {
    public static final int SINGLETON_ID = 1;

    @PrimaryKey
    public int id;

    @NonNull
    @ColumnInfo(name = "installation_id")
    public String installationId;

    @ColumnInfo(name = "next_sequence")
    public long nextSequence;

    @ColumnInfo(name = "created_at_ms")
    public long createdAtMs;

    public SyncInstallationEntity(int id, @NonNull String installationId, long nextSequence, long createdAtMs) {
        this.id = id;
        this.installationId = installationId;
        this.nextSequence = nextSequence;
        this.createdAtMs = createdAtMs;
    }
}
