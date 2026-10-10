package xyz.etherings.player.alpha;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class AlphaMarketplaceRoutesTest {
    private static final String MINT = "8f8djakwJPs1fu8HVX82Kk8jQP2VHfmCjEjyX98yDzFA";

    @Test public void permitsOnlyExpectedMarketplacePaths() {
        assertTrue(AlphaAuthApi.isWalletGet("/me/marketplace/listings"));
        assertTrue(AlphaAuthApi.isWalletGet("/me/marketplace/listing/" + MINT));
        for (String action : new String[] { "review", "refresh", "submit", "status" })
            assertTrue(AlphaAuthApi.isWalletPost("/me/marketplace/" + action));
        assertFalse(AlphaAuthApi.isWalletGet("/me/marketplace/listing/../config"));
        assertFalse(AlphaAuthApi.isWalletGet("/me/marketplace/listing/" + MINT + "?all=true"));
        assertFalse(AlphaAuthApi.isWalletPost("/me/marketplace/admin"));
    }
}
