package xyz.etherings.player.alpha.wallet;

import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class GatewayTransferIntentTest {
    private GatewayTransferIntent intent(long amount, long nonce, long expiry) {
        return new GatewayTransferIntent("authority", "source", "destination",
                "treasury", "config", "replay", "mint", "meta", "sysvar",
                "token", "hook", "system", "gateway", amount, nonce, expiry);
    }

    @Test
    public void rejectsInvalidEconomicFields() {
        assertThrows(IllegalArgumentException.class, () -> intent(0, 1, 100));
        assertThrows(IllegalArgumentException.class, () -> intent(1, -1, 100));
        assertThrows(IllegalArgumentException.class, () -> intent(1, 1, 0));
    }

    @Test
    public void rejectsEmptyMessageBeforeAnySignerIsUsed() {
        assertThrows(IllegalArgumentException.class,
                () -> new GatewayMessagePolicy(intent(1, 1, 100)).validate(new byte[0]));
    }
}
