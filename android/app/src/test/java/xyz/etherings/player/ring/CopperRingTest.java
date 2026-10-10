package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class CopperRingTest {
    static final String RING_ID = "11111111-1111-4111-8111-111111111111";

    @Test
    public void parsesAndRoundTripsThePlayerSafeCopperContract() throws Exception {
        CopperRing ring = CopperRing.fromJson(ringJson(RING_ID, true));

        assertEquals(RING_ID, ring.id());
        assertEquals("COPPER", ring.ringKind());
        assertEquals(1, ring.level());
        assertEquals(100, ring.shine());
        assertEquals(2, ring.comfort());
        assertEquals(20, ring.charm());
        assertEquals(7, ring.quality());
        assertEquals(11, ring.luck());
        assertEquals(8, ring.unspentAttributePoints());
        assertTrue(ring.equipped());
        assertFalse(ring.toJson().has("ownerUserId"));
        assertEquals(RING_ID, CopperRing.fromJson(ring.toJson()).id());
    }

    @Test
    public void rejectsNonCopperAndInvalidProgressValues() throws Exception {
        JSONObject nonCopper = ringJson(RING_ID, true).put("ringKind", "GOLD");
        JSONObject invalidId = ringJson("not-a-uuid", true);
        JSONObject invalidLevel = ringJson(RING_ID, true).put("level", 21);
        JSONObject invalidAttribute = ringJson(RING_ID, true)
                .put("attributes", new JSONObject().put("comfort", -1).put("charm", 2).put("quality", 2).put("luck", 2));

        assertThrows(JSONException.class, () -> CopperRing.fromJson(nonCopper));
        assertThrows(JSONException.class, () -> CopperRing.fromJson(invalidId));
        assertThrows(JSONException.class, () -> CopperRing.fromJson(invalidLevel));
        assertThrows(JSONException.class, () -> CopperRing.fromJson(invalidAttribute));
    }

    @Test
    public void equippedWrapperRequiresServerEquippedState() throws Exception {
        assertThrows(JSONException.class, () -> EquippedCopperRing.fromJson(new JSONObject()
                .put("ring", ringJson(RING_ID, false))
                .put("equippedAt", "2026-08-19T12:02:00.000Z")));
    }

    static JSONObject ringJson(String id, boolean equipped) throws JSONException {
        return new JSONObject()
                .put("id", id)
                .put("ringKind", "COPPER")
                .put("status", "ACTIVE")
                .put("level", 1)
                .put("shine", 100)
                .put("attributes", new JSONObject()
                        .put("comfort", 2)
                        .put("charm", 20)
                        .put("quality", 7)
                        .put("luck", 11))
                .put("unspentAttributePoints", 8)
                .put("visualVariantCode", "copper_celtic")
                .put("visualSetVersion", "copper-visual-v1")
                .put("rulesetVersion", "copper-rules-v1")
                .put("equipped", equipped)
                .put("createdAt", "2026-08-19T12:00:00.000Z")
                .put("updatedAt", "2026-08-19T12:01:00.000Z");
    }
}
