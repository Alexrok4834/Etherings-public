package xyz.etherings.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

public final class BindingChallengeTest {
    private static final String ACCOUNT = "11111111-2222-3333-4444-555555555555";
    private static final String ADDRESS = "11111111111111111111111111111111";
    private static final String NONCE = "a".repeat(64);
    private static final long ISSUED = 1_779_116_400_000L;
    private static final long EXPIRES = ISSUED + 600_000L;

    private static String message() {
        return "EtheRings Alpha wallet binding\nversion=1\naccount=" + ACCOUNT +
                "\nwallet=" + ADDRESS + "\nenvironment=alpha-local\nnonce=" + NONCE +
                "\nissued_at_ms=" + ISSUED + "\nexpires_at_ms=" + EXPIRES + "\n";
    }

    private static BindingChallenge parse(String message) throws Exception {
        return BindingChallenge.decode(Base64.getEncoder().encodeToString(message.getBytes(StandardCharsets.US_ASCII)),
                NONCE, EXPIRES, ACCOUNT, ADDRESS, "alpha-local", ISSUED + 1_000);
    }

    @Test public void acceptsExactCanonicalBindingMessage() throws Exception {
        assertEquals(ADDRESS, parse(message()).walletAddress);
    }

    @Test public void rejectsChangedOrExtraFieldsBeforeSigning() {
        for (String altered : new String[] {
                message().replace(ACCOUNT, "aaaaaaaa-2222-3333-4444-555555555555"),
                message().replace(ADDRESS, "22222222222222222222222222222222"),
                message().replace("alpha-local", "alpha-other"),
                message().replace(NONCE, "b".repeat(64)),
                message().replace("version=1", "version=2"),
                message().replace("expires_at_ms=" + EXPIRES, "expires_at_ms=" + (EXPIRES + 1)),
                message() + "extra=1\n"
        }) assertThrows(IllegalArgumentException.class, () -> parse(altered));
        assertThrows(IllegalArgumentException.class, () -> BindingChallenge.decode(
                Base64.getEncoder().encodeToString(message().getBytes(StandardCharsets.US_ASCII)),
                NONCE, EXPIRES, ACCOUNT, ADDRESS, "alpha-local", EXPIRES));
    }
}
