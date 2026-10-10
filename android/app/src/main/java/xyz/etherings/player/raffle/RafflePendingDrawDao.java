package xyz.etherings.player.raffle;

import androidx.annotation.Nullable;
import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;

@Dao
public interface RafflePendingDrawDao {
    @Nullable
    @Query("SELECT * FROM raffle_pending_draw WHERE owner_id = :ownerId LIMIT 1")
    RafflePendingDrawEntity get(String ownerId);

    @Insert(onConflict = OnConflictStrategy.ABORT)
    void insert(RafflePendingDrawEntity entity);

    @Query("UPDATE raffle_pending_draw SET state = 'UNCERTAIN', updated_at_ms = :nowMs "
            + "WHERE owner_id = :ownerId AND idempotency_key = :key AND state = 'SUBMITTING'")
    int markUncertain(String ownerId, String key, long nowMs);

    @Query("UPDATE raffle_pending_draw SET state = 'COMPLETED_UNREVEALED', "
            + "response_snapshot = :snapshot, terminal_error_code = NULL, updated_at_ms = :nowMs "
            + "WHERE owner_id = :ownerId AND idempotency_key = :key "
            + "AND state IN ('SUBMITTING', 'UNCERTAIN')")
    int storeCompleted(String ownerId, String key, String snapshot, long nowMs);

    @Query("UPDATE raffle_pending_draw SET state = 'TERMINAL_REJECTED', "
            + "response_snapshot = NULL, terminal_error_code = :errorCode, updated_at_ms = :nowMs "
            + "WHERE owner_id = :ownerId AND idempotency_key = :key "
            + "AND state IN ('SUBMITTING', 'UNCERTAIN')")
    int markTerminalRejected(String ownerId, String key, String errorCode, long nowMs);

    @Query("UPDATE raffle_pending_draw SET state = 'REVEALED', updated_at_ms = :nowMs "
            + "WHERE owner_id = :ownerId AND idempotency_key = :key "
            + "AND state = 'COMPLETED_UNREVEALED'")
    int markRevealed(String ownerId, String key, long nowMs);

    @Query("DELETE FROM raffle_pending_draw WHERE owner_id = :ownerId AND idempotency_key = :key "
            + "AND state = 'COMPLETED_UNREVEALED'")
    int acknowledgeCompleted(String ownerId, String key);

    @Query("DELETE FROM raffle_pending_draw WHERE owner_id = :ownerId AND idempotency_key = :key "
            + "AND state IN ('REVEALED', 'TERMINAL_REJECTED')")
    int clearTerminal(String ownerId, String key);
}
