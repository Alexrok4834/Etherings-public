package xyz.etherings.player.sync;

import android.os.Looper;

import java.util.UUID;

import xyz.etherings.player.economy.ErtValue;

public final class RoomSyncStatusPublisher {
    private final StepSyncDao dao;
    private final SyncStatusStore statusStore;

    public RoomSyncStatusPublisher(EtheringsDatabase database, SyncStatusStore statusStore) {
        this.dao = database.stepSyncDao();
        this.statusStore = statusStore;
    }

    public SyncStatusSnapshot publish(String ownerId) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new IllegalStateException("Sync status Room queries must not run on the main thread");
        }
        String normalizedOwnerId = UUID.fromString(ownerId).toString();
        SyncStatusSnapshot current = statusStore.snapshot(normalizedOwnerId);
        ErtValue syncedErt = ErtValue.zero();
        for (String exact : dao.syncedErtExactValues(normalizedOwnerId)) {
            syncedErt = syncedErt.add(ErtValue.fromExact(exact));
        }
        SyncStatusSnapshot next = new SyncStatusSnapshot(
                dao.pendingStepCount(normalizedOwnerId),
                dao.pendingBatchCount(normalizedOwnerId),
                dao.heldStepCount(normalizedOwnerId),
                dao.heldBatchCount(normalizedOwnerId),
                dao.syncedStepCount(normalizedOwnerId),
                syncedErt,
                dao.syncedBatchCount(normalizedOwnerId),
                dao.rejectedStepCount(normalizedOwnerId),
                dao.rejectedBatchCount(normalizedOwnerId),
                dao.lastSuccessfulSyncAtMs(normalizedOwnerId),
                current.lastAttemptAtMs(),
                current.authRequired()
        );
        statusStore.save(normalizedOwnerId, next);
        return next;
    }
}
