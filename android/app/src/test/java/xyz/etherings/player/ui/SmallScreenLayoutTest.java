package xyz.etherings.player.ui;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public final class SmallScreenLayoutTest {
    @Test
    public void capsActivityListOnTallScreens() {
        assertEquals(1080, SmallScreenLayout.activityDialogListHeightPx(2400, 3f));
    }

    @Test
    public void usesHalfOfCompactScreenWhenWithinBounds() {
        assertEquals(600, SmallScreenLayout.activityDialogListHeightPx(1200, 3f));
    }

    @Test
    public void keepsMinimumUsableHeightForVeryShortScreens() {
        assertEquals(480, SmallScreenLayout.activityDialogListHeightPx(700, 3f));
    }
}
