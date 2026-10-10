package xyz.etherings.player.alpha.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class WalletAssetSnapshotTest {
    @Test public void exactBaseUnitFormatting() {
        WalletAssetSnapshot value = WalletAssetSnapshot.from("devnet", "owner", "owner",
                "mint", "mint", "500000001", "30600000000");
        assertEquals("0.500000001", value.sol);
        assertEquals("30.6", value.eru);
        assertEquals("0", WalletAssetSnapshot.from("devnet", "owner", "owner",
                "mint", "mint", "0", "0").eru);
    }

    @Test public void identityOrAmountMismatchRejectsBeforeDisplay() {
        assertThrows(IllegalArgumentException.class, () -> WalletAssetSnapshot.from(
                "local-validator", "owner", "owner", "mint", "mint", "1", "1"));
        assertThrows(IllegalArgumentException.class, () -> WalletAssetSnapshot.from(
                "devnet", "other", "owner", "mint", "mint", "1", "1"));
        assertThrows(IllegalArgumentException.class, () -> WalletAssetSnapshot.from(
                "devnet", "owner", "owner", "wrong", "mint", "1", "1"));
        assertThrows(IllegalArgumentException.class, () -> WalletAssetSnapshot.from(
                "devnet", "owner", "owner", "mint", "mint", "-1", "1"));
    }

    @Test public void devnetTestTransferRequiresExactAdditiveDebit() {
        assertFalse(WalletAssetSnapshot.covers("2400000000", 30_600_000_000L));
        assertFalse(WalletAssetSnapshot.covers("30599999999", 30_600_000_000L));
        assertTrue(WalletAssetSnapshot.covers("30600000000", 30_600_000_000L));
        assertThrows(IllegalArgumentException.class,
                () -> WalletAssetSnapshot.covers("30.6", 30_600_000_000L));
    }
}
