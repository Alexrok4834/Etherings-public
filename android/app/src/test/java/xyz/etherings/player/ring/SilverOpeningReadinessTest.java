package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class SilverOpeningReadinessTest {
    private static final String BOX = "2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq";
    private static final String TEST_ESCROW = "EdXT16XWGS5vf1X2ezwaL5TB6ZLb5XqsMxBF439FmHmi";

    private JSONObject response() throws Exception {
        return new JSONObject().put("cluster", "devnet").put("mintAddress", BOX)
                .put("walletAddress", "2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc")
                .put("escrowAddress", TEST_ESCROW).put("signingEnabled", false);
    }

    @Test public void acceptsOnlyReadOnlyExactDevnetPreflight() throws Exception {
        assertEquals(TEST_ESCROW, SilverOpeningReadiness.parse(response(), BOX).escrowAddress);
        assertThrows(Exception.class, () -> SilverOpeningReadiness.parse(
                response().put("signingEnabled", true), BOX));
        assertThrows(Exception.class, () -> SilverOpeningReadiness.parse(
                response().put("cluster", "local-validator"), BOX));
        assertThrows(Exception.class, () -> SilverOpeningReadiness.parse(
                response(), "47kk2K18NNxP5DgvkL5zZu1RUtfZqKVz8kdPU88bHR9R"));
    }

    @Test public void signedDevnetPreflightMustBeExplicitlyEnabled() throws Exception {
        assertEquals(TEST_ESCROW, SilverOpeningReadiness.parse(
                response().put("signingEnabled", true), BOX, true).escrowAddress);
        assertThrows(Exception.class, () -> SilverOpeningReadiness.parse(response(), BOX, true));
    }
}
