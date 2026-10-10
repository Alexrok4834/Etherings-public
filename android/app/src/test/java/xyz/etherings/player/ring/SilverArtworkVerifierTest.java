package xyz.etherings.player.ring;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.security.MessageDigest;

public final class SilverArtworkVerifierTest {
    private static final String URI =
            "ipfs://bafybeichpgwqh2qo4zm7tedm7zhndw7nps3dom3fnucjbcufpq6es3knsi";

    @Test public void acceptsOnlyExactImageBytesFromCanonicalUri() throws Exception {
        byte[] png = new byte[33];
        byte[] signature = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};
        System.arraycopy(signature, 0, png, 0, signature.length);
        png[12] = 'I'; png[13] = 'H'; png[14] = 'D'; png[15] = 'R';
        png[16] = 0; png[17] = 0; png[18] = 4; png[19] = (byte) 230;
        png[20] = 0; png[21] = 0; png[22] = 4; png[23] = (byte) 230;
        png[24] = 8; png[25] = 6;
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(png);
        StringBuilder hash = new StringBuilder();
        for (byte value : digest) hash.append(String.format("%02x", value & 255));
        assertTrue(SilverArtworkVerifier.matches(URI, hash.toString(), "image/png", png));
        assertTrue(SilverArtworkVerifier.validUri(
                "ipfs://bafybeibcro7norourb437e7pz3lvurcumxubp2wxkldipd6h4tvlxnkhbq/silver_box_closed.png"));
        assertFalse(SilverArtworkVerifier.validUri(URI + "/../other.png"));
        assertFalse(SilverArtworkVerifier.matches(URI, "0".repeat(64), "image/png", png));
        assertFalse(SilverArtworkVerifier.matches(URI, hash.toString(), "text/html", png));
        assertFalse(SilverArtworkVerifier.matches("https://example.com/image", hash.toString(),
                "image/png", png));
        png[25] = 2;
        assertFalse(SilverArtworkVerifier.matches(URI, hash.toString(), "image/png", png));
    }
}
