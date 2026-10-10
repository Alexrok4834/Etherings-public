package xyz.etherings.player.alpha.wallet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public class WalletOperationTest {
    private static final String ID = "00000000-0000-4000-8000-000000000001";
    private static final String CREATED = "2026-09-25T12:03:00.000Z";

    @Test public void allDurableStatesRemainDistinct() {
        for (String state : new String[] { "pending", "confirmed", "failed", "unknown" }) {
            WalletOperation operation = WalletOperation.from(ID, "2", "send", "out",
                    "10", "0.2", "2".repeat(32), state, null, CREATED);
            assertEquals(state, operation.status);
            assertEquals("2", operation.nonce);
            assertNull(operation.shortSignature());
        }
    }

    @Test public void invalidIdentityOrStateFailsBeforeDisplay() {
        assertThrows(IllegalArgumentException.class, () -> WalletOperation.from(ID, "0", "send", "out", "10", "0.2", "2".repeat(32), "pending", null, CREATED));
        assertThrows(IllegalArgumentException.class, () -> WalletOperation.from(ID, "1", "send", "out", "10", "0.2", "2".repeat(32), "submitting", null, CREATED));
        assertThrows(IllegalArgumentException.class, () -> WalletOperation.from("wrong", "1", "send", "out", "10", "0.2", "2".repeat(32), "confirmed", null, CREATED));
        assertThrows(IllegalArgumentException.class, () -> WalletOperation.from(ID, "1", "send", "out", "10", "0.2", "2".repeat(32), "confirmed", "bad", CREATED));
    }

    @Test public void transactionSignatureIsShortenedOnlyForDisplay() {
        String signature = "2".repeat(88);
        WalletOperation operation = WalletOperation.from(ID, "3", "send", "out",
                "10", "0.2", "2".repeat(32), "confirmed", signature, CREATED);
        assertEquals("22222222...22222222", operation.shortSignature());
        assertEquals(signature, operation.transactionSignature);
    }

    @Test public void lostSubmitResponseIsUnknownOnlyForMatchingOperation() {
        WalletOperation pending = WalletOperation.from(ID, "3", "send", "out",
                "10", "0.2", "2".repeat(32), "pending", null, CREATED);
        assertEquals("unknown", pending.displayStatus(ID));
        assertEquals("pending", pending.displayStatus("00000000-0000-4000-8000-000000000002"));
        WalletOperation confirmed = WalletOperation.from(ID, "3", "send", "out",
                "10", "0.2", "2".repeat(32), "confirmed", null, CREATED);
        assertEquals("confirmed", confirmed.displayStatus(ID));
        WalletOperation failed = WalletOperation.from(ID, "3", "send", "out",
                "10", "0.2", "2".repeat(32), "failed", null, CREATED);
        assertEquals("failed", failed.displayStatus(ID));
    }

    @Test public void semanticEntriesPreserveDirectionAndOptionalFee() {
        WalletOperation received = WalletOperation.from(ID, "7", "send", "in",
                "10", null, "2".repeat(32), "confirmed", "3".repeat(88), CREATED);
        assertEquals("in", received.direction);
        assertEquals("10", received.amount);
        assertNull(received.fee);
        WalletOperation reward = WalletOperation.from(ID, null, "draw_reward", "in",
                "5", null, null, "confirmed", "3".repeat(88), CREATED);
        assertNull(reward.nonce);
        assertThrows(IllegalArgumentException.class, () -> WalletOperation.from(ID, null,
                "send", "out", "10", "0.2", "2".repeat(32), "confirmed", null, CREATED));
        assertThrows(IllegalArgumentException.class, () -> WalletOperation.from(ID, null,
                "draw_reward", "out", "5", null, null, "confirmed", null, CREATED));
    }
}
