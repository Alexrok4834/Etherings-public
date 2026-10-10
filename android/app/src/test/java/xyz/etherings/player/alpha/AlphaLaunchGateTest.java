package xyz.etherings.player.alpha;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class AlphaLaunchGateTest {
    @Test public void grantIsExactAndSingleUse() {
        AlphaLaunchGate.grant("verified@example.invalid");
        assertFalse(AlphaLaunchGate.consume("other@example.invalid"));
        assertFalse(AlphaLaunchGate.consume("verified@example.invalid"));
        AlphaLaunchGate.grant("verified@example.invalid");
        assertTrue(AlphaLaunchGate.consume("verified@example.invalid"));
        assertFalse(AlphaLaunchGate.consume("verified@example.invalid"));
    }
}
