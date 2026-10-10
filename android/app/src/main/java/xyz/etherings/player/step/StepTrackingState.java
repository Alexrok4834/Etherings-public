package xyz.etherings.player.step;

public final class StepTrackingState {
    public enum Status {
        UNSUPPORTED,
        PERMISSION_REQUIRED,
        READY,
        TRACKING,
        STALE,
        DEGRADED_BACKGROUND
    }

    private static final long STALE_AFTER_MS = 15L * 60L * 1000L;

    private final Status status;
    private final int eventCount;
    private final long lastSensorUpdateAtMs;
    private final String message;

    private StepTrackingState(Status status, int eventCount, long lastSensorUpdateAtMs, String message) {
        this.status = status;
        this.eventCount = Math.max(0, eventCount);
        this.lastSensorUpdateAtMs = Math.max(0L, lastSensorUpdateAtMs);
        this.message = message == null ? "" : message;
    }

    public static StepTrackingState from(
            StepSensorCapability capability,
            boolean activityPermissionGranted,
            int eventCount,
            long lastSensorUpdateAtMs,
            long nowMs,
            boolean backgroundRestricted
    ) {
        if (capability == null || !capability.isStepCounterSupported()) {
            return new StepTrackingState(Status.UNSUPPORTED, eventCount, lastSensorUpdateAtMs, "Native step counter unsupported on this device");
        }

        if (capability.isActivityRecognitionPermissionRequired() && !activityPermissionGranted) {
            return new StepTrackingState(Status.PERMISSION_REQUIRED, eventCount, lastSensorUpdateAtMs, "Activity permission required for automatic step tracking");
        }

        if (backgroundRestricted) {
            return new StepTrackingState(Status.DEGRADED_BACKGROUND, eventCount, lastSensorUpdateAtMs, "Background tracking may be restricted by this device");
        }

        if (eventCount <= 0 || lastSensorUpdateAtMs <= 0L) {
            return new StepTrackingState(Status.READY, eventCount, lastSensorUpdateAtMs, "Automatic step tracking ready; waiting for sensor events");
        }

        if (nowMs > 0L && nowMs - lastSensorUpdateAtMs > STALE_AFTER_MS) {
            return new StepTrackingState(Status.STALE, eventCount, lastSensorUpdateAtMs, "Step sensor events are stale");
        }

        return new StepTrackingState(Status.TRACKING, eventCount, lastSensorUpdateAtMs, "Automatic step tracking active");
    }

    public Status status() {
        return status;
    }

    public int eventCount() {
        return eventCount;
    }

    public long lastSensorUpdateAtMs() {
        return lastSensorUpdateAtMs;
    }

    public String message() {
        return message;
    }

    public boolean canTrack() {
        return status == Status.READY || status == Status.TRACKING || status == Status.STALE;
    }
}