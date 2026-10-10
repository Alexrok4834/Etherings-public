package xyz.etherings.player.sync;

import androidx.room.TypeConverter;

import xyz.etherings.player.raffle.RafflePendingDrawState;

public final class SyncTypeConverters {
    private SyncTypeConverters() {
    }

    @TypeConverter
    public static String batchStateToString(SyncBatchState state) {
        return state == null ? null : state.name();
    }

    @TypeConverter
    public static SyncBatchState stringToBatchState(String value) {
        return value == null ? null : SyncBatchState.valueOf(value);
    }

    @TypeConverter
    public static String pendingDrawStateToString(RafflePendingDrawState state) {
        return state == null ? null : state.name();
    }

    @TypeConverter
    public static RafflePendingDrawState stringToPendingDrawState(String value) {
        return value == null ? null : RafflePendingDrawState.valueOf(value);
    }
}
