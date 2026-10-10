package xyz.etherings.player.home;

public final class PassiveProfileRefreshGate {
    private long observedSuccessfulSyncAtMs;
    private boolean baselineEstablished;
    private boolean refreshInFlight;

    public synchronized void observe(long successfulSyncAtMs) {
        observedSuccessfulSyncAtMs = Math.max(observedSuccessfulSyncAtMs, Math.max(0L, successfulSyncAtMs));
        baselineEstablished = true;
    }

    public synchronized boolean beginIfAdvanced(long successfulSyncAtMs) {
        if (successfulSyncAtMs <= 0L) {
            return false;
        }
        if (!baselineEstablished) {
            observedSuccessfulSyncAtMs = successfulSyncAtMs;
            baselineEstablished = true;
            return false;
        }
        if (successfulSyncAtMs <= observedSuccessfulSyncAtMs || refreshInFlight) {
            return false;
        }
        observedSuccessfulSyncAtMs = successfulSyncAtMs;
        refreshInFlight = true;
        return true;
    }

    public synchronized void finish() {
        refreshInFlight = false;
    }
}
