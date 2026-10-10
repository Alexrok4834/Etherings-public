package xyz.etherings.player.step;

import java.time.Instant;
import java.time.ZoneId;
import java.util.concurrent.TimeUnit;

/** Converts the sensor's elapsed-realtime timestamp to the current local-day wall clock. */
final class StepSensorEventTime {
    private StepSensorEventTime() {
    }

    static long observedAtMs(long callbackWallMs, long callbackElapsedNanos,
            long eventElapsedNanos) {
        if (eventElapsedNanos <= 0L || eventElapsedNanos > callbackElapsedNanos) {
            return callbackWallMs;
        }
        long ageMs = TimeUnit.NANOSECONDS.toMillis(callbackElapsedNanos - eventElapsedNanos);
        if (ageMs > callbackWallMs) return callbackWallMs;
        long eventWallMs = callbackWallMs - ageMs;
        ZoneId zone = ZoneId.systemDefault();
        if (!Instant.ofEpochMilli(eventWallMs).atZone(zone).toLocalDate().equals(
                Instant.ofEpochMilli(callbackWallMs).atZone(zone).toLocalDate())) {
            // Keep the existing callback-day attribution for a sensor event delivered after midnight.
            return callbackWallMs;
        }
        return eventWallMs;
    }
}
