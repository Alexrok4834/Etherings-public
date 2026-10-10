package xyz.etherings.player.step;

public final class StepCounterSnapshot {
    private final long totalSteps;
    private final long dailySteps;
    private final long rewardWindowSteps;
    private final long rewardWindowStartedAtMs;
    private final long lastRawCounter;
    private final int eventCount;
    private final long lastSensorUpdateAtMs;
    private final String dailyDate;

    StepCounterSnapshot(
            long totalSteps,
            long dailySteps,
            long rewardWindowSteps,
            long rewardWindowStartedAtMs,
            long lastRawCounter,
            int eventCount,
            long lastSensorUpdateAtMs,
            String dailyDate
    ) {
        this.totalSteps = Math.max(0L, totalSteps);
        this.dailySteps = Math.max(0L, dailySteps);
        this.rewardWindowSteps = Math.max(0L, rewardWindowSteps);
        this.rewardWindowStartedAtMs = Math.max(0L, rewardWindowStartedAtMs);
        this.lastRawCounter = Math.max(0L, lastRawCounter);
        this.eventCount = Math.max(0, eventCount);
        this.lastSensorUpdateAtMs = Math.max(0L, lastSensorUpdateAtMs);
        this.dailyDate = dailyDate == null ? "" : dailyDate;
    }

    public long totalSteps() {
        return totalSteps;
    }

    public long dailySteps() {
        return dailySteps;
    }

    public long rewardWindowSteps() {
        return rewardWindowSteps;
    }

    public long rewardWindowStartedAtMs() {
        return rewardWindowStartedAtMs;
    }

    public long lastRawCounter() {
        return lastRawCounter;
    }

    public int eventCount() {
        return eventCount;
    }

    public long lastSensorUpdateAtMs() {
        return lastSensorUpdateAtMs;
    }

    public String dailyDate() {
        return dailyDate;
    }
}
