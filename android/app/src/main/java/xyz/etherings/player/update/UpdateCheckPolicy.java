package xyz.etherings.player.update;

public final class UpdateCheckPolicy {
    public static final long SUCCESS_CACHE_MS = 6L * 60L * 60L * 1000L;
    public static final long OPTIONAL_DISMISS_MS = 24L * 60L * 60L * 1000L;
    public static final long REQUIRED_DISMISS_MS = 6L * 60L * 60L * 1000L;
    private static final long INITIAL_FAILURE_BACKOFF_MS = 15L * 60L * 1000L;
    private static final long MAX_FAILURE_BACKOFF_MS = 24L * 60L * 60L * 1000L;

    private UpdateCheckPolicy() {}

    public static long failureBackoffMs(int consecutiveFailures) {
        int exponent = Math.max(0, Math.min(consecutiveFailures - 1, 7));
        long delay = INITIAL_FAILURE_BACKOFF_MS << exponent;
        return Math.min(delay, MAX_FAILURE_BACKOFF_MS);
    }

    public static boolean isFresh(long nowMs, long recordedAtMs, long durationMs) {
        return recordedAtMs > 0 && nowMs >= recordedAtMs && nowMs - recordedAtMs < durationMs;
    }
}
