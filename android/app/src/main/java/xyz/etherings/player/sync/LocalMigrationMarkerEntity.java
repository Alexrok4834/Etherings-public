package xyz.etherings.player.sync;

import androidx.annotation.NonNull;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

@Entity(tableName = "local_migration_marker")
public final class LocalMigrationMarkerEntity {
    @NonNull
    @PrimaryKey
    public String name;

    @ColumnInfo(name = "source_schema_version")
    public int sourceSchemaVersion;

    @ColumnInfo(name = "completed_at_ms")
    public long completedAtMs;

    public LocalMigrationMarkerEntity(@NonNull String name, int sourceSchemaVersion, long completedAtMs) {
        this.name = name;
        this.sourceSchemaVersion = sourceSchemaVersion;
        this.completedAtMs = completedAtMs;
    }
}
