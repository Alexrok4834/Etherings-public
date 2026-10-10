package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class CopperRingUiTextTest {
    @Test
    public void describesTheApprovedRingWithoutInventedMetadata() throws Exception {
        CopperRing ring = CopperRing.fromJson(CopperRingTest.ringJson(CopperRingTest.RING_ID, true));

        assertEquals("Cooper ring, level 1, Shine 100", CopperRingUiText.contentDescription(ring));
    }
}
