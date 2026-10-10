package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class SilverInventorySnapshotTest {
    private static final String BOX = "2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq";
    private static final String RING = "64uJRs7vk9ATD9P24H5kS8QwZ87RBsF5QvmfiC7UjpUT";
    private static final String OLD_BOX = "47kk2K18NNxP5DgvkL5zZu1RUtfZqKVz8kdPU88bHR9R";

    private JSONObject box() throws Exception {
        return new JSONObject().put("kind", "SILVER_BOX").put("mintAddress", BOX)
                .put("serial", "1")
                .put("issuanceId", "a".repeat(64)).put("lifecycle", "SEALED")
                .put("cooldownUntilUnixSeconds", "0");
    }

    private JSONObject ring() throws Exception {
        return new JSONObject().put("kind", "SILVER_RING").put("mintAddress", RING)
                .put("serial", "1")
                .put("boxMint", OLD_BOX).put("designId", 1)
                .put("uri", "ipfs://bafybeichpgwqh2qo4zm7tedm7zhndw7nps3dom3fnucjbcufpq6es3knsi")
                .put("contentHash", "a".repeat(64))
                .put("level", 1).put("shine", 100).put("unspentPoints", 0)
                .put("comfort", 15).put("charm", 20).put("quality", 25).put("luck", 30)
                .put("lastDirectTransferSlot", "0").put("cooldownUntilUnixSeconds", "0");
    }

    @Test public void parsesOnlyConfirmedOwnedBoxAndRingProjection() throws Exception {
        String uri = ring().getString("uri");
        SilverInventorySnapshot snapshot = SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(box().put("uri", uri)
                        .put("contentHash", "b".repeat(64))).put(ring())));
        assertEquals(2, snapshot.assets().size());
        assertEquals(BOX, snapshot.assets().get(0).mint);
        assertEquals("1", snapshot.assets().get(0).serial);
        assertEquals("0", snapshot.assets().get(0).cooldownUntilUnixSeconds);
        assertEquals(uri, snapshot.assets().get(0).uri);
        assertEquals("b".repeat(64), snapshot.assets().get(0).contentHash);
        assertEquals(1, snapshot.assets().get(1).designId);
        assertEquals(ring().getString("uri"), snapshot.assets().get(1).uri);
        assertEquals("a".repeat(64), snapshot.assets().get(1).contentHash);
        assertEquals(null, snapshot.assets().get(0).level);
        assertEquals(Integer.valueOf(1), snapshot.assets().get(1).level);
        assertEquals(Integer.valueOf(100), snapshot.assets().get(1).shine);
        assertEquals(Integer.valueOf(0), snapshot.assets().get(1).unspentPoints);
        assertEquals(Integer.valueOf(15), snapshot.assets().get(1).comfort);
        assertEquals(Integer.valueOf(20), snapshot.assets().get(1).charm);
        assertEquals(Integer.valueOf(25), snapshot.assets().get(1).quality);
        assertEquals(Integer.valueOf(30), snapshot.assets().get(1).luck);
        assertEquals("0", snapshot.assets().get(1).lastDirectTransferSlot);
        assertEquals("0", snapshot.assets().get(1).cooldownUntilUnixSeconds);
    }

    @Test public void missingOrUnsupportedBoxMediaDoesNotChangeOwnedState() throws Exception {
        SilverInventorySnapshot snapshot = SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(box().put("uri", "https://example.invalid")
                        .put("contentHash", "0".repeat(64)))));
        assertEquals(1, snapshot.assets().size());
        assertEquals("SEALED", snapshot.assets().get(0).lifecycle);
        assertEquals(null, snapshot.assets().get(0).uri);
    }

    @Test public void rejectsPendingFakeAndDuplicateAssets() throws Exception {
        assertThrows(Exception.class, () -> {
            JSONObject legacy = box();
            legacy.remove("serial");
            SilverInventorySnapshot.parse(new JSONObject()
                    .put("assets", new JSONArray().put(legacy)));
        });
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("serial", "0")))));
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("serial", "9".repeat(21))))));
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(box().put("lifecycle", "OPENING")))));
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(box()).put(box()))));
        SilverInventorySnapshot unsupported = SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("uri", "https://example.com/asset"))));
        assertEquals(1, unsupported.assets().size());
        assertEquals(null, unsupported.assets().get(0).uri);
        SilverInventorySnapshot badHash = SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("contentHash", "bad"))));
        assertEquals(1, badHash.assets().size());
        assertEquals(null, badHash.assets().get(0).contentHash);
    }

    @Test public void openingBoxRequiresExplicitProgramEscrowCustody() throws Exception {
        SilverInventorySnapshot snapshot = SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(box().put("lifecycle", "OPENING")
                        .put("custody", "PROGRAM_ESCROW").put("openingStatus", "pending"))));
        assertEquals(true, snapshot.assets().get(0).isOpening());
        assertEquals("pending", snapshot.assets().get(0).openingStatus);
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(box().put("lifecycle", "OPENING")
                        .put("custody", "USER")))));
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(box().put("lifecycle", "OPENING")
                        .put("custody", "PROGRAM_ESCROW").put("openingStatus", "confirmed")))));
    }

    @Test public void completedOpeningIsRingNotBox() throws Exception {
        SilverInventorySnapshot snapshot = SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("openingStatus", "confirmed"))));
        assertEquals("confirmed", snapshot.assets().get(0).openingStatus);
        assertEquals(OLD_BOX, snapshot.assets().get(0).boxMint);
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("openingStatus", "pending")))));
    }

    @Test public void acceptsProgressedSilverWithoutChangingInitialGenerationBounds() throws Exception {
        JSONObject progressed = ring().put("level", 2).put("unspentPoints", 5)
                .put("comfort", 16);
        SilverInventorySnapshot snapshot = SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(progressed)));
        assertEquals(Integer.valueOf(2), snapshot.assets().get(0).level);
        assertEquals(Integer.valueOf(5), snapshot.assets().get(0).unspentPoints);
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("level", 1)
                        .put("unspentPoints", 6)))));
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("level", 2)
                        .put("unspentPoints", 7)))));
        assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring().put("level", 2)
                        .put("comfort", 37)))));
    }

    @Test public void ringGameplayRejectsUnsupportedOrMalformedState() throws Exception {
        for (String field : new String[] { "level", "shine", "unspentPoints",
                "comfort", "charm", "quality", "luck", "lastDirectTransferSlot",
                "cooldownUntilUnixSeconds" }) {
            JSONObject missing = ring();
            missing.remove(field);
            assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                    .put("assets", new JSONArray().put(missing))));
        }
        for (Object[] mutation : new Object[][] {
                {"level", 21}, {"shine", 99}, {"unspentPoints", 1},
                {"comfort", 9}, {"charm", 31}, {"quality", 0}, {"luck", 99},
                {"lastDirectTransferSlot", "-1"}, {"cooldownUntilUnixSeconds", "-1"},
                {"lastDirectTransferSlot", "1"},
                {"cooldownUntilUnixSeconds", "9223372036854775808"} }) {
            assertThrows(Exception.class, () -> SilverInventorySnapshot.parse(new JSONObject()
                    .put("assets", new JSONArray().put(ring().put((String) mutation[0], mutation[1])))));
        }
        SilverInventorySnapshot transferred = SilverInventorySnapshot.parse(new JSONObject()
                .put("assets", new JSONArray().put(ring()
                        .put("lastDirectTransferSlot", "18446744073709551615")
                        .put("cooldownUntilUnixSeconds", "9223372036854775807"))));
        assertEquals("18446744073709551615",
                transferred.assets().get(0).lastDirectTransferSlot);
    }
}
