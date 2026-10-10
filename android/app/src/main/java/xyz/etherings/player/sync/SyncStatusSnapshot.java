package xyz.etherings.player.sync;

import xyz.etherings.player.economy.ErtValue;

public final class SyncStatusSnapshot {
    private final long pendingSteps;
    private final int pendingBatches;
    private final long heldSteps;
    private final int heldBatches;
    private final long syncedSteps;
    private final ErtValue syncedErt;
    private final int syncedBatches;
    private final long rejectedSteps;
    private final int rejectedBatches;
    private final long lastSuccessfulSyncAtMs;
    private final long lastAttemptAtMs;
    private final boolean authRequired;

    public SyncStatusSnapshot(
            long pendingSteps,
            int pendingBatches,
            long syncedSteps,
            ErtValue syncedErt,
            int syncedBatches,
            long rejectedSteps,
            int rejectedBatches,
            long lastSuccessfulSyncAtMs,
            long lastAttemptAtMs,
            boolean authRequired
    ) {
        this(pendingSteps, pendingBatches, 0L, 0, syncedSteps, syncedErt, syncedBatches,
                rejectedSteps, rejectedBatches, lastSuccessfulSyncAtMs, lastAttemptAtMs, authRequired);
    }

    public SyncStatusSnapshot(
            long pendingSteps,
            int pendingBatches,
            long heldSteps,
            int heldBatches,
            long syncedSteps,
            ErtValue syncedErt,
            int syncedBatches,
            long rejectedSteps,
            int rejectedBatches,
            long lastSuccessfulSyncAtMs,
            long lastAttemptAtMs,
            boolean authRequired
    ) {
        this.pendingSteps = Math.max(0L, pendingSteps);
        this.pendingBatches = Math.max(0, pendingBatches);
        this.heldSteps = Math.min(this.pendingSteps, Math.max(0L, heldSteps));
        this.heldBatches = Math.min(this.pendingBatches, Math.max(0, heldBatches));
        this.syncedSteps = Math.max(0L, syncedSteps);
        this.syncedErt = syncedErt == null ? ErtValue.zero() : syncedErt;
        this.syncedBatches = Math.max(0, syncedBatches);
        this.rejectedSteps = Math.max(0L, rejectedSteps);
        this.rejectedBatches = Math.max(0, rejectedBatches);
        this.lastSuccessfulSyncAtMs = Math.max(0L, lastSuccessfulSyncAtMs);
        this.lastAttemptAtMs = Math.max(0L, lastAttemptAtMs);
        this.authRequired = authRequired;
    }

    public long pendingSteps() { return pendingSteps; }
    public int pendingBatches() { return pendingBatches; }
    public long heldSteps() { return heldSteps; }
    public int heldBatches() { return heldBatches; }
    public long syncedSteps() { return syncedSteps; }
    public long syncedErt() { return syncedErt.wholeUnitsFloor(); }
    ErtValue syncedErtValue() { return syncedErt; }
    public String syncedErtExact() { return syncedErt.exact(); }
    public String syncedErtDisplay() { return syncedErt.display(); }
    public int syncedBatches() { return syncedBatches; }
    public long rejectedSteps() { return rejectedSteps; }
    public int rejectedBatches() { return rejectedBatches; }
    public long lastSuccessfulSyncAtMs() { return lastSuccessfulSyncAtMs; }
    public long lastAttemptAtMs() { return lastAttemptAtMs; }
    public boolean authRequired() { return authRequired; }

    public static SyncStatusSnapshot empty() {
        return new SyncStatusSnapshot(0L, 0, 0L, ErtValue.zero(), 0, 0L, 0, 0L, 0L, false);
    }
}
