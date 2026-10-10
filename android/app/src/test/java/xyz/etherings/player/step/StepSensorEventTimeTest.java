package xyz.etherings.player.step;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

import java.time.Instant;
import java.util.TimeZone;

public final class StepSensorEventTimeTest {
    @Test
    public void usesEventTimeForStepsDeliveredTogether() {
        long receivedAt = Instant.parse("2026-10-08T10:00:10Z").toEpochMilli();
        long elapsedAtReceipt = 20_000_000_000L;
        assertEquals(receivedAt - 2_000L,
                StepSensorEventTime.observedAtMs(receivedAt, elapsedAtReceipt, 18_000_000_000L));
        assertEquals(receivedAt - 1_000L,
                StepSensorEventTime.observedAtMs(receivedAt, elapsedAtReceipt, 19_000_000_000L));
    }

    @Test
    public void invalidOrPreviousDaySensorTimeKeepsExistingReceiptDay() {
        TimeZone previous = TimeZone.getDefault();
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"));
        try {
            long receivedAt = Instant.parse("2026-10-08T00:00:10Z").toEpochMilli();
            long elapsedAtReceipt = 20_000_000_000L;
            assertEquals(receivedAt,
                    StepSensorEventTime.observedAtMs(receivedAt, elapsedAtReceipt, 0L));
            assertEquals(receivedAt,
                    StepSensorEventTime.observedAtMs(receivedAt, elapsedAtReceipt, 21_000_000_000L));
            assertEquals(receivedAt,
                    StepSensorEventTime.observedAtMs(receivedAt, elapsedAtReceipt, 5_000_000_000L));
        } finally {
            TimeZone.setDefault(previous);
        }
    }
}
