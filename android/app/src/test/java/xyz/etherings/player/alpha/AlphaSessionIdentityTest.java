package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

public final class AlphaSessionIdentityTest {
    private static final String TOKEN = "a".repeat(64);
    private static final String OWNER = "12345678-1234-4123-8123-123456789abc";
    private static final String INSTALLATION = "12345678-1234-4123-8123-123456789abd";
    private static final String LINEAGE = "12345678-1234-4123-8123-123456789abe";

    @Test public void legacySessionCanBeReadButHasNoVerifiedOwner() {
        AlphaSessionIdentity identity = AlphaSessionIdentity.decode(1, TOKEN);
        assertEquals(TOKEN, identity.token);
        assertNull(identity.accountId);
    }

    @Test public void verifiedIdentityIsBoundToSameEncryptedPayload() {
        AlphaSessionIdentity identity = AlphaSessionIdentity.decode(2,
                AlphaSessionIdentity.verified(TOKEN, OWNER).encode());
        assertEquals(TOKEN, identity.token);
        assertEquals(OWNER, identity.accountId);
    }

    @Test public void malformedAndMixedIdentityCannotBeAccepted() {
        assertThrows(IllegalArgumentException.class,
                () -> AlphaSessionIdentity.verified(TOKEN, OWNER.toUpperCase()));
        assertThrows(IllegalArgumentException.class,
                () -> AlphaSessionIdentity.decode(2, TOKEN + "\n" + OWNER + "\n" + OWNER));
        assertThrows(IllegalArgumentException.class,
                () -> AlphaSessionIdentity.decode(1, TOKEN + "\n" + OWNER));
        assertThrows(IllegalArgumentException.class,
                () -> AlphaSessionIdentity.decode(3, TOKEN));
    }

    @Test public void renewableIdentityRoundTripsWithOwnerAndInstallation() {
        AlphaSessionIdentity identity = AlphaSessionIdentity.renewable(TOKEN, OWNER,
                "a".repeat(43), "2026-11-03T00:00:00Z", INSTALLATION, LINEAGE);
        AlphaSessionIdentity restored = AlphaSessionIdentity.decode(3, identity.encode());
        assertEquals(OWNER, restored.accountId);
        assertEquals(INSTALLATION, restored.installationId);
        assertEquals(LINEAGE, restored.lineage);
        assertEquals("a".repeat(43), restored.refreshToken);
        assertThrows(IllegalArgumentException.class,
                () -> AlphaSessionIdentity.decode(3, identity.encode() + "\nextra"));
    }
}
