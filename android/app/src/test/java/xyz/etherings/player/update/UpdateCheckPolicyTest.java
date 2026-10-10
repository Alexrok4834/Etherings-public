package xyz.etherings.player.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class UpdateCheckPolicyTest {
    @Test
    public void backsOffFailuresFromFifteenMinutesToOneDay() {
        assertEquals(15L * 60L * 1000L, UpdateCheckPolicy.failureBackoffMs(1));
        assertEquals(30L * 60L * 1000L, UpdateCheckPolicy.failureBackoffMs(2));
        assertEquals(24L * 60L * 60L * 1000L, UpdateCheckPolicy.failureBackoffMs(8));
        assertEquals(24L * 60L * 60L * 1000L, UpdateCheckPolicy.failureBackoffMs(100));
    }

    @Test
    public void treatsFutureOrExpiredTimestampsAsNotFresh() {
        assertTrue(UpdateCheckPolicy.isFresh(1_500L, 1_000L, 1_000L));
        assertFalse(UpdateCheckPolicy.isFresh(2_000L, 1_000L, 1_000L));
        assertFalse(UpdateCheckPolicy.isFresh(999L, 1_000L, 1_000L));
    }
}
