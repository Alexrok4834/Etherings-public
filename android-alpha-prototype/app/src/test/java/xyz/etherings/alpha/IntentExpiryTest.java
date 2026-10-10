package xyz.etherings.alpha;

import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class IntentExpiryTest {
    @Test public void acceptsOnlyCurrentDevnetWindow() {
        IntentExpiry.requireCluster("devnet", "devnet");
        IntentExpiry.requireDevnet(500_000_000L, 500_000_600L, 1);
        IntentExpiry.requireDevnet(500_000_001L, 500_000_600L, 2);
        IntentExpiry.requireDevnet(500_000_600L, 500_000_600L, 2);
    }

    @Test public void rejectsExpiredOversizedAndWrongCluster() {
        assertThrows(IllegalArgumentException.class,
                () -> IntentExpiry.requireDevnet(500_000_601L, 500_000_600L, 1));
        assertThrows(IllegalArgumentException.class,
                () -> IntentExpiry.requireDevnet(500_000_000L, 500_000_601L, 1));
        assertThrows(IllegalArgumentException.class,
                () -> IntentExpiry.requireDevnet(500_000_000L, 500_000_600L, 0));
        assertThrows(IllegalArgumentException.class,
                () -> IntentExpiry.requireCluster("devnet", "local-validator"));
    }
}
