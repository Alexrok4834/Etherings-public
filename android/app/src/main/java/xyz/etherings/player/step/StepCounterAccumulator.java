package xyz.etherings.player.step;

final class StepCounterAccumulator {
    static final class State {
        final long totalSteps;
        final long dailySteps;
        final long rewardWindowSteps;
        final long lastRawCounter;
        final boolean rawCounterInitialized;
        final String dailyDate;

        State(
                long totalSteps,
                long dailySteps,
                long rewardWindowSteps,
                long lastRawCounter,
                boolean rawCounterInitialized,
                String dailyDate
        ) {
            this.totalSteps = nonNegative(totalSteps);
            this.dailySteps = nonNegative(dailySteps);
            this.rewardWindowSteps = nonNegative(rewardWindowSteps);
            this.lastRawCounter = nonNegative(lastRawCounter);
            this.rawCounterInitialized = rawCounterInitialized;
            this.dailyDate = dailyDate == null ? "" : dailyDate;
        }

        State resetRewardWindow() {
            return new State(totalSteps, dailySteps, 0L, lastRawCounter, rawCounterInitialized, dailyDate);
        }
    }

    private StepCounterAccumulator() {
    }

    static State fromLegacy(
            long rawCounter,
            long totalBaseline,
            long dailyBaseline,
            long rewardBaseline,
            boolean rawCounterInitialized,
            String dailyDate
    ) {
        return new State(
                rawCounter - totalBaseline,
                rawCounter - dailyBaseline,
                rawCounter - rewardBaseline,
                rawCounter,
                rawCounterInitialized,
                dailyDate
        );
    }

    static State record(State current, long rawCounter, String today) {
        long safeRawCounter = nonNegative(rawCounter);
        String safeToday = today == null ? "" : today;
        long delta = 0L;

        if (current.rawCounterInitialized) {
            delta = safeRawCounter >= current.lastRawCounter
                    ? safeRawCounter - current.lastRawCounter
                    : 0L;
        }

        boolean newDay = !safeToday.equals(current.dailyDate);
        long nextDailySteps = (newDay ? 0L : current.dailySteps) + delta;
        return new State(
                current.totalSteps + delta,
                nextDailySteps,
                current.rewardWindowSteps + delta,
                safeRawCounter,
                true,
                safeToday
        );
    }

    static State rollDay(State current, String today) {
        String safeToday = today == null ? "" : today;
        if (safeToday.equals(current.dailyDate)) {
            return current;
        }
        return new State(
                current.totalSteps,
                0L,
                current.rewardWindowSteps,
                current.lastRawCounter,
                current.rawCounterInitialized,
                safeToday
        );
    }

    private static long nonNegative(long value) {
        return Math.max(0L, value);
    }
}
