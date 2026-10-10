package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class AlphaIdentityTest {
    @Test
    public void alphaDebugIdentityUsesOnlyLoopbackDevApi() {
        assertEquals("xyz.etherings.alpha", BuildConfig.APPLICATION_ID);
        assertEquals("alpha", BuildConfig.RELEASE_CHANNEL);
        assertTrue(BuildConfig.DEBUG);
        assertEquals("http://127.0.0.1:19081", BuildConfig.ALPHA_API_BASE_URL);
    }
}
