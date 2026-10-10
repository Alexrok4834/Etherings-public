package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import org.robolectric.RobolectricTestRunner;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.Base64;

import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;
import xyz.etherings.player.alpha.wallet.GatewayMessagePolicy;

@RunWith(RobolectricTestRunner.class)
public final class CanonicalEruSendPolicyTest {
    // Public unsigned Kit candidate from backend-alpha's canonical Send builder.
    private static final String WALLET = "gBxS1f6uyyGPuW5MzGBukidSb71jdsCb5fZaoSzULE5";
    private static final String RECIPIENT = "k7FaK87WHGVXzkaoHb7CdVPgkKDQhZ29VLDeBVbDfYn";
    private static final long AMOUNT = 1_000_000_001L;
    private static final String MESSAGE = "AQAKEAoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKMnNLEwJU2wS3nSxos8zx1TGrBHXJBxiyZVOuVu65v0RpQdgEc0dUTG+852LDSsHaL7DM+ybLvxKmTnXvKVUOSoQMxTUZl6ipWcVUveGIg8xpb98dn52Ps6rSlWi6b/DJsL6kb6IgjUqctPHT/zWPDgHhLdabsf/zvuAahzLE79vGLbZ3hz7Prmyhd5wNhi7ZYBxdVYQWidqSkp3YMOkBGAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFauTw/KqPFnAhDu3RHIxDsA+rFuZ5yoOkVEUPIZX/sg/gKgNOgh/V8vutg8uHx7t8JKsdtwSDc0oc/T0tqUUT4yXJY9OJInxuz0QKRSODYMLWhOZ2v8QhASOe9jb6fhZnA0SegLC+0JrRWJraHQtQ8qIwX6altAgA1DC2/6jXSEDBkZv5SEXMv/srbpyw5vnvIzlu8X3EmssQ5s6QAAAANk/BaEOanK5vVoxfDlvhuUmEO8OPmYv0G2b9tvto5sgCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsGp9UXGHvRZjXa1ARV/cLAwSTGjyFWdaXbustfCAAAAAbd9uHudY/eGEJdvORszdq2GvxNg7kNJ/69+SjYoYv8FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQDCwAFAsAnCQAJBgACDQcGDwEBDA0DBwIEAAEKDg8IBQAGGQEBypo7AAAAAAEAAAAAAAAAvAIAAAAAAAA=";

    private static byte[] message() { return Base64.getDecoder().decode(MESSAGE); }

    private static CanonicalEruSendPolicy policy() throws Exception {
        return new CanonicalEruSendPolicy(WALLET, RECIPIENT, AMOUNT);
    }

    private static byte[] mutateKey(String key) {
        byte[] candidate = message();
        byte[] expected = AssociatedTokenAddress.decode(key);
        int found = -1;
        for (int index = 0; index <= candidate.length - expected.length; index++) {
            if (!Arrays.equals(Arrays.copyOfRange(candidate, index, index + 32), expected)) continue;
            if (found >= 0) throw new AssertionError("ambiguous key fixture");
            found = index;
        }
        if (found < 0) throw new AssertionError("key missing from fixture");
        candidate[found] ^= 1;
        return candidate;
    }

    @Test public void acceptsOnlyBoundCanonicalCandidateAndExactEconomics() throws Exception {
        GatewayMessagePolicy.Decoded decoded = policy().validate(message(), 100);
        assertEquals(AMOUNT, decoded.amountBaseUnits);
        assertEquals(20_000_001L, decoded.feeBaseUnits);
        assertEquals(1, decoded.nonce);
        assertEquals(700, decoded.expirySlot);
        assertEquals(AssociatedTokenAddress.derive(RECIPIENT,
                CooperEruPolicy.TOKEN_2022, CooperEruPolicy.MINT), decoded.destination);
        assertEquals(CooperEruPolicy.TREASURY, decoded.treasury);
        assertEquals(AssociatedTokenAddress.derive(WALLET,
                CooperEruPolicy.TOKEN_2022, CooperEruPolicy.MINT), decoded.intent().source);
        assertEquals(CooperEruPolicy.GATEWAY, decoded.intent().gateway);
        assertThrows(IllegalArgumentException.class,
                () -> new CanonicalEruSendPolicy(RECIPIENT, WALLET, AMOUNT)
                        .validate(message(), 100));
        assertThrows(IllegalArgumentException.class,
                () -> new CanonicalEruSendPolicy(WALLET,
                        "11111111111111111111111111111111", AMOUNT).validate(message(), 100));
    }

    @Test public void rejectsChangedCanonicalIdentitiesBeforeSigning() throws Exception {
        GatewayMessagePolicy.Decoded decoded = policy().validate(message(), 100);
        for (String key : new String[] { decoded.intent().source, decoded.intent().destination,
                decoded.intent().mint, decoded.intent().treasury, decoded.intent().config,
                decoded.intent().meta, decoded.intent().replay, decoded.intent().hook,
                decoded.intent().gateway }) {
            assertThrows(IllegalArgumentException.class,
                    () -> policy().validate(mutateKey(key), 100));
        }
    }

    @Test public void rejectsChangedAmountNonceExpiryAndMessageGraph() throws Exception {
        assertThrows(IllegalArgumentException.class,
                () -> new CanonicalEruSendPolicy(WALLET, RECIPIENT, AMOUNT - 1)
                        .validate(message(), 100));
        assertThrows(IllegalArgumentException.class, () -> policy().validate(message(), 701));
        byte[] nonce = message();
        byte[] encoded = ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
                .putLong(AMOUNT).array();
        int amountOffset = -1;
        for (int index = 0; index <= nonce.length - encoded.length; index++) {
            if (!Arrays.equals(Arrays.copyOfRange(nonce, index, index + 8), encoded)) continue;
            if (amountOffset >= 0) throw new AssertionError("ambiguous amount fixture");
            amountOffset = index;
        }
        if (amountOffset < 0) throw new AssertionError("amount missing from fixture");
        nonce[amountOffset + 8] = 0;
        assertThrows(IllegalArgumentException.class, () -> policy().validate(nonce, 100));
        byte[] signer = message();
        signer[0] = 2;
        assertThrows(IllegalArgumentException.class, () -> policy().validate(signer, 100));
        byte[] extra = Arrays.copyOf(message(), message().length + 1);
        assertThrows(IllegalArgumentException.class, () -> policy().validate(extra, 100));
    }

    @Test public void requiresExactlyTheReviewedBackendCandidateBeforeSigning() throws Exception {
        String id = "00000000-0000-4000-8000-000000000001";
        JSONObject same = new JSONObject().put("cluster", "devnet").put("id", id)
                .put("message", MESSAGE);
        assertEquals(1, policy().requireSameCandidate(same, id, message(), 100).nonce);
        assertThrows(IllegalArgumentException.class,
                () -> policy().requireSameCandidate(new JSONObject(same.toString())
                        .put("id", "00000000-0000-4000-8000-000000000002"),
                        id, message(), 100));
        assertThrows(IllegalArgumentException.class,
                () -> policy().requireSameCandidate(new JSONObject(same.toString())
                        .put("message", Base64.getEncoder().encodeToString(mutateKey(
                                CooperEruPolicy.MINT))), id, message(), 100));
        assertThrows(IllegalArgumentException.class,
                () -> policy().requireSameCandidate(same, id, message(), 701));
    }
}
