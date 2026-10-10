package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

import xyz.etherings.player.alpha.wallet.AssociatedTokenAddress;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class SilverOpeningReviewTest {
    private JSONObject vector(String name) throws Exception {
        try (InputStream input = getClass().getResourceAsStream("/" + name)) {
            if (input == null) throw new IllegalStateException("Kit vector unavailable");
            return new JSONObject(new String(input.readAllBytes(), StandardCharsets.UTF_8));
        }
    }

    @Test public void exactKitMessageIsDecodedForReadOnlyDevnetReview() throws Exception {
        JSONObject vector = vector("silver-opening-kit-vector.json");
        JSONObject pinned = vector.getJSONObject("policy");
        JSONObject response = vector.getJSONObject("response").put("cluster", "devnet");
        SilverOpeningPolicy policy = SilverOpeningPolicy.forReview(response,
                pinned.getString("authority"), pinned.getString("mint"),
                pinned.getString("escrow"), pinned.getString("silver"));
        SilverOpeningPolicy.Decoded decoded = policy.validateResponse(response);
        assertEquals(pinned.getString("authority"), decoded.authority);
        assertEquals(pinned.getString("request"), decoded.request);
        assertEquals(pinned.getString("escrow"), decoded.escrow);
        assertEquals(pinned.getString("source"), policy.value("source"));
        assertEquals(decoded.message().length, policy.requireApprovedMessage(response,
                pinned.getString("authority")).length);
        assertThrows(Exception.class, () -> policy.requireApprovedMessage(response,
                pinned.getString("source")));

        assertThrows(Exception.class, () -> SilverOpeningPolicy.forReview(response,
                pinned.getString("source"), pinned.getString("mint"),
                pinned.getString("escrow"), pinned.getString("silver")));
        assertThrows(Exception.class, () -> SilverOpeningPolicy.forReview(response,
                pinned.getString("authority"), pinned.getString("source"),
                pinned.getString("escrow"), pinned.getString("silver")));
        assertThrows(Exception.class, () -> policy.validateResponse(
                new JSONObject(response.toString()).put("cluster", "local-validator")));
        assertThrows(Exception.class, () -> policy.validateResponse(
                new JSONObject(response.toString()).put("request", pinned.getString("source"))));
    }

    @Test public void changedInstructionsAndAccountsFailBeforeAnySigning() throws Exception {
        JSONObject vector = vector("silver-opening-kit-vector.json");
        JSONObject pinned = vector.getJSONObject("policy");
        JSONObject response = vector.getJSONObject("response").put("cluster", "devnet");
        SilverOpeningPolicy policy = SilverOpeningPolicy.forReview(response,
                pinned.getString("authority"), pinned.getString("mint"),
                pinned.getString("escrow"), pinned.getString("silver"));
        byte[] original = Base64.getDecoder().decode(response.getString("messageBase64"));
        for (int position : new int[] { 0, 2, 4, 4 + 9 * 32, original.length - 1 }) {
            byte[] changed = original.clone();
            changed[position] ^= 1;
            JSONObject mutation = new JSONObject(response.toString()).put("messageBase64",
                    Base64.getEncoder().encodeToString(changed));
            assertThrows(Exception.class, () -> policy.validateResponse(mutation));
        }
        assertThrows(Exception.class, () -> policy.validateResponse(
                new JSONObject(response.toString()).put("messageBase64", "AQ==")));
    }

    @Test public void marketAwareBoxReviewPinsMarketplaceAndListingBeforeSigning() throws Exception {
        JSONObject vector = vector("silver-opening-market-kit-vector.json");
        JSONObject pinned = vector.getJSONObject("policy");
        JSONObject response = vector.getJSONObject("response").put("cluster", "devnet");
        SilverOpeningPolicy policy = SilverOpeningPolicy.forReview(response,
                pinned.getString("authority"), pinned.getString("mint"),
                pinned.getString("escrow"), pinned.getString("silver"));
        assertEquals("BD6ANsUmGDPxBaqnggerm3DgHWt95dnRu2Sru586do1j",
                policy.value("market"));
        assertEquals(pinned.getString("listing"), policy.value("listing"));
        assertEquals(884, policy.validateResponse(response).message().length);

        byte[] original = Base64.getDecoder().decode(response.getString("messageBase64"));
        for (String field : new String[] { "market", "listing" }) {
            byte[] changed = original.clone();
            byte[] key = AssociatedTokenAddress.decode(pinned.getString(field));
            int offset = -1;
            for (int index = 4; index <= 4 + 22 * 32 - key.length; index += 32) {
                if (Arrays.equals(Arrays.copyOfRange(changed, index, index + 32), key)) {
                    offset = index;
                    break;
                }
            }
            if (offset < 0) throw new AssertionError("fixture account missing: " + field);
            changed[offset] ^= 1;
            JSONObject mutation = new JSONObject(response.toString()).put("messageBase64",
                    Base64.getEncoder().encodeToString(changed));
            assertThrows(Exception.class, () -> SilverOpeningPolicy.forReview(mutation,
                    pinned.getString("authority"), pinned.getString("mint"),
                    pinned.getString("escrow"), pinned.getString("silver")));
            assertThrows(Exception.class, () -> policy.validateResponse(mutation));
        }
    }

    @Test public void actualDevnetGraphUsesDerivedAccountsNotServerLabels() throws Exception {
        JSONObject response = vector("silver-opening-devnet-kit-vector.json");
        SilverOpeningPolicy policy = SilverOpeningPolicy.forReview(response,
                "2FxK6uAFufk4hdL2Yz5zBHvb653RS7VeBJSd1P6PtEHc",
                "2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq",
                "3HfkLQ398SCaQkm6dsQuaYoou1mNaHoP6p1tXMNVYXcd",
                "3t5KA3cDtJdfnKHvumvsTypKp37e3zEVJ9HE3YmYT5wX");
        policy.validateResponse(response);
        SilverOpeningChainClock.requireDerivedAccounts(policy, 1, 1);
        assertThrows(Exception.class, () -> SilverOpeningChainClock.requireDerivedAccounts(
                policy, 2, 1));
        assertThrows(Exception.class, () -> SilverOpeningChainClock.requireDerivedAccounts(
                policy, 1, 2));
    }
}
