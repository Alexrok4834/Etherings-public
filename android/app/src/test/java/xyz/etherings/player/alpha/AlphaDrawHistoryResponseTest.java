package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class AlphaDrawHistoryResponseTest {
    @Test public void historyOnlyGetsBoundedLargerResponse() {
        assertTrue(AlphaAuthApi.isWalletGet("/raffle/v2/history"));
        assertEquals(524_288, AlphaAuthApi.responseLimit("/raffle/v2/history"));
        assertEquals(16_384, AlphaAuthApi.responseLimit("/raffle/v2/draw"));
        assertEquals(16_384, AlphaAuthApi.responseLimit("/wallet/assets"));
    }
}
