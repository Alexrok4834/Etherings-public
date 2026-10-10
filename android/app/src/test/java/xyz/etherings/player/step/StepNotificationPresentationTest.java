package xyz.etherings.player.step;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import org.junit.Test;

public final class StepNotificationPresentationTest {
    @Test
    public void usesApprovedBrandSpellingAndDailyProgress() {
        assertEquals("EtheRings step tracking", StepNotificationPresentation.title());
        assertEquals("Today: 407 / 5000 steps", StepNotificationPresentation.content(true, 407, 5000));
        assertFalse(StepNotificationPresentation.content(true, 407, 5000).contains("Window"));
    }

    @Test
    public void reportsUnavailableSensorWithoutInventingProgress() {
        assertEquals("Step sensor unavailable", StepNotificationPresentation.content(false, 407, 5000));
    }

    @Test
    public void doesNotInventALimitBeforeServerCapIsKnown() {
        assertEquals("Today: 407 / -- steps", StepNotificationPresentation.content(true, 407, null));
    }
}
