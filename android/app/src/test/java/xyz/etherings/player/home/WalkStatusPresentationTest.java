package xyz.etherings.player.home;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.sync.SyncStatusSnapshot;

public final class WalkStatusPresentationTest {
    @Test
    public void separatesLocalServerAndRewardWindowValues() {
        WalkStatusPresentation status = WalkStatusPresentation.from(
                407L,
                48L,
                293,
                "2.00",
                snapshot(0L, 0, 4_523L, "45.13065", 246L, false),
                "14/08/26, 11:46"
        );

        assertEquals("On this phone today: 407 steps", status.localSteps());
        assertEquals("Current reward window: 48 steps", status.rewardWindow());
        assertEquals("Accepted by server today: 293 steps", status.acceptedSteps());
        assertEquals("ERT earned today: 2.00", status.earnedErt());
        assertTrue(status.deliveryStatus().contains("Delivery queue: empty"));
        assertTrue(status.deliveryStatus().contains("Delivered by this device (all time): 4523 steps / 45.13 ERT"));
        assertTrue(status.deliveryStatus().contains("Rejected by server (all time): 246 steps"));
        assertTrue(status.deliveryStatus().contains("Last successful delivery: 14/08/26, 11:46"));
        assertFalse(status.deliveryStatus().contains("events"));
    }

    @Test
    public void reportsQueuedBatchWithoutCallingItAccepted() {
        WalkStatusPresentation status = WalkStatusPresentation.from(
                214L,
                14L,
                100,
                "1.00",
                snapshot(114L, 1, 100L, "1", 0L, false),
                "never"
        );

        assertTrue(status.deliveryStatus().startsWith("Waiting to send: 114 steps in 1 batch"));
        assertFalse(status.deliveryStatus().contains("114 accepted"));
    }

    @Test
    public void reportsAuthenticationBlockInsteadOfEmptyQueue() {
        WalkStatusPresentation status = WalkStatusPresentation.from(
                10L,
                10L,
                0,
                "0.00",
                snapshot(10L, 2, 0L, "0", 0L, true),
                "never"
        );

        assertTrue(status.deliveryStatus().startsWith("Delivery paused: sign in required"));
        assertFalse(status.deliveryStatus().contains("Delivery queue: empty"));
    }

    @Test
    public void separatesHeldStepsFromSendableSteps() {
        SyncStatusSnapshot sync = new SyncStatusSnapshot(
                121L, 2, 100L, 1, 21L, ErtValue.fromExact("0.027659560975609756"),
                1, 0L, 0, 1000L, 1100L, false);
        WalkStatusPresentation status = WalkStatusPresentation.from(
                121L, 0L, 21, "0.03", sync, "today");
        assertTrue(status.deliveryStatus().contains("Waiting to send: 21 steps in 1 batch"));
        assertTrue(status.deliveryStatus().contains("Held for review: 100 steps in 1 batch"));
        assertTrue(status.deliveryStatus().contains("no ERT credited"));
    }

    private static SyncStatusSnapshot snapshot(
            long pendingSteps,
            int pendingBatches,
            long syncedSteps,
            String syncedErt,
            long rejectedSteps,
            boolean authRequired
    ) {
        return new SyncStatusSnapshot(
                pendingSteps,
                pendingBatches,
                syncedSteps,
                ErtValue.fromExact(syncedErt),
                syncedSteps == 0L ? 0 : 1,
                rejectedSteps,
                rejectedSteps == 0L ? 0 : 1,
                0L,
                0L,
                authRequired
        );
    }
}
