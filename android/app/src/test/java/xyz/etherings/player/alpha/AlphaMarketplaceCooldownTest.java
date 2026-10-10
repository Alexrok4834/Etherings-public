package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AlphaMarketplaceCooldownTest {
    @Test public void verifiedCooldownGetsReadableExpiry() throws Exception {
        JSONObject body = new JSONObject().put("code", "MARKETPLACE_LISTING_COOLDOWN")
                .put("cooldownUntilUnixSeconds", "1893456000");
        String text = AlphaMarketplaceClient.marketplaceError(409, body);
        assertTrue(text.startsWith("This NFT is in transfer cooldown."));
        assertTrue(text.contains("You can use it after"));
        assertTrue(text.contains("(device time)"));
    }

    @Test public void malformedOrUnrelatedErrorCannotInventExpiry() throws Exception {
        JSONObject body = new JSONObject().put("code", "MARKETPLACE_LISTING_COOLDOWN")
                .put("cooldownUntilUnixSeconds", "99999999999999999999999");
        assertEquals("This NFT is in transfer cooldown. Try using it after cooldown ends.",
                AlphaMarketplaceClient.marketplaceError(409, body));
        assertEquals("MARKETPLACE_LISTING_COOLDOWN",
                AlphaMarketplaceClient.marketplaceError(503, body));
    }

    @Test public void listEquipAndProgressionUseOneVerifiedNotice() throws Exception {
        JSONObject listing = new JSONObject().put("code", "MARKETPLACE_LISTING_COOLDOWN")
                .put("cooldownUntilUnixSeconds", "1893456000");
        JSONObject silver = new JSONObject().put("code", "SILVER_RING_COOLDOWN")
                .put("cooldownUntilUnixSeconds", "1893456000");
        assertEquals(AlphaMarketplaceClient.marketplaceError(409, listing),
                AlphaSilverCooldownNotice.forResponse(409, silver));
        assertEquals(null, AlphaSilverCooldownNotice.forResponse(503, silver));
        assertEquals(null, AlphaSilverCooldownNotice.forResponse(409,
                new JSONObject().put("code", "SILVER_RING_LISTED")));
    }
}
