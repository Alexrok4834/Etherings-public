package xyz.etherings.player.home;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.sync.SyncStatusSnapshot;

public final class AlphaStepReceiptPresentationTest {
    @Test public void showsOnlyLocalTodayAndAllTimeDeviceDelivery() {
        AlphaStepReceiptPresentation view = AlphaStepReceiptPresentation.from(
                214L, 14L, "2026-09-27", "2026-09-27",
                new SyncStatusSnapshot(114L, 1, 100L, ErtValue.fromExact("0.13065"),
                        1, 0L, 0, 0L, 0L, false), "never", 6000);

        assertEquals("214 / 6000 steps", view.progress());
        assertEquals("On this phone today: 214 steps", view.localSteps());
        assertEquals("Current reward window: 14 steps", view.rewardWindow());
        assertTrue(view.deliveryStatus().contains("Waiting to send: 114 steps in 1 batch"));
        assertTrue(view.deliveryStatus().contains("Delivered by this device (all time): 100 steps / 0.13 ERT"));
        assertFalse(view.deliveryStatus().contains("ERT earned today"));
        assertFalse(view.deliveryStatus().contains("Accepted by server today"));
    }

    @Test public void staleLocalDayIsNotPresentedAsToday() {
        AlphaStepReceiptPresentation view = AlphaStepReceiptPresentation.from(
                214L, 14L, "2026-09-26", "2026-09-27", SyncStatusSnapshot.empty(), "never", null);

        assertEquals("0 / -- steps", view.progress());
        assertEquals("On this phone today: 0 steps", view.localSteps());
        assertEquals("Current reward window: 0 steps", view.rewardWindow());
    }
}
