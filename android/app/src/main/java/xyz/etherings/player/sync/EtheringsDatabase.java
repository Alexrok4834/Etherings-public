package xyz.etherings.player.sync;

import android.content.Context;

import androidx.room.Database;
import androidx.room.Room;
import androidx.room.RoomDatabase;
import androidx.room.TypeConverters;
import androidx.room.migration.Migration;
import androidx.sqlite.db.SupportSQLiteDatabase;

import androidx.annotation.NonNull;

import xyz.etherings.player.raffle.RafflePendingDrawDao;
import xyz.etherings.player.raffle.RafflePendingDrawEntity;

@Database(
        entities = {
                SyncInstallationEntity.class,
                StepAccumulatorEntity.class,
                StepOutboxBatchEntity.class,
                LocalMigrationMarkerEntity.class,
                RafflePendingDrawEntity.class
        },
        version = 4,
        exportSchema = true
)
@TypeConverters({SyncTypeConverters.class})
public abstract class EtheringsDatabase extends RoomDatabase {
    public static final String DATABASE_NAME = "etherings_player.db";
    public static final Migration MIGRATION_1_2 = new Migration(1, 2) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE step_outbox_batch ADD COLUMN earned_ert_delta_exact TEXT");
            database.execSQL("ALTER TABLE step_outbox_batch ADD COLUMN earned_ert_delta_display TEXT");
            database.execSQL(
                    "UPDATE step_outbox_batch "
                            + "SET earned_ert_delta_exact = CAST(earned_ert_delta AS TEXT), "
                            + "earned_ert_delta_display = CAST(earned_ert_delta AS TEXT) || '.00' "
                            + "WHERE earned_ert_delta IS NOT NULL"
            );
        }
    };
    public static final Migration MIGRATION_2_3 = new Migration(2, 3) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL(
                    "CREATE TABLE IF NOT EXISTS raffle_pending_draw ("
                            + "owner_id TEXT NOT NULL PRIMARY KEY, "
                            + "contract_version TEXT NOT NULL, "
                            + "configuration_version TEXT NOT NULL, "
                            + "idempotency_key TEXT NOT NULL, "
                            + "state TEXT NOT NULL, "
                            + "response_snapshot TEXT, "
                            + "terminal_error_code TEXT, "
                            + "created_at_ms INTEGER NOT NULL, "
                            + "updated_at_ms INTEGER NOT NULL)"
            );
            database.execSQL(
                    "CREATE UNIQUE INDEX IF NOT EXISTS index_raffle_pending_draw_idempotency_key "
                            + "ON raffle_pending_draw(idempotency_key)"
            );
        }
    };
    public static final Migration MIGRATION_3_4 = new Migration(3, 4) {
        @Override
        public void migrate(@NonNull SupportSQLiteDatabase database) {
            database.execSQL("ALTER TABLE step_accumulator ADD COLUMN comfort_boundary_at_ms INTEGER NOT NULL DEFAULT 0");
        }
    };

    private static volatile EtheringsDatabase instance;

    public abstract StepSyncDao stepSyncDao();
    public abstract RafflePendingDrawDao rafflePendingDrawDao();

    public static EtheringsDatabase open(Context context) {
        EtheringsDatabase current = instance;
        if (current != null) {
            return current;
        }

        synchronized (EtheringsDatabase.class) {
            if (instance == null) {
                instance = Room.databaseBuilder(
                        context.getApplicationContext(),
                        EtheringsDatabase.class,
                        DATABASE_NAME
                ).addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4).build();
            }
            return instance;
        }
    }
}
