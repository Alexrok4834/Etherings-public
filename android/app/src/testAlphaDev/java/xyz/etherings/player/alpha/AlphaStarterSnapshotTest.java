package xyz.etherings.player.alpha;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import xyz.etherings.player.ring.AlphaStarterSnapshot;
import xyz.etherings.player.ring.CopperRing;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AlphaStarterSnapshotTest {
    @Test public void authoritativeCooperAndPendingBoxRemainDistinct() throws Exception {
        JSONObject ring = new JSONObject()
                .put("id", "aa971cd4-3d54-4079-a6dc-45fb3fb3325b")
                .put("ringKind", "COPPER").put("status", "ACTIVE")
                .put("level", 1).put("shine", 100)
                .put("attributes", new JSONObject().put("comfort", 2)
                        .put("charm", 20).put("quality", 7).put("luck", 11))
                .put("unspentAttributePoints", 0)
                .put("visualVariantCode", "copper_signet")
                .put("visualSetVersion", "copper-visual-v1")
                .put("rulesetVersion", "copper-rules-v1")
                .put("equipped", true)
                .put("createdAt", "2026-09-26T00:00:00Z")
                .put("updatedAt", "2026-09-26T00:00:00Z");
        CopperRing cooper = CopperRing.fromJson(ring);
        AlphaStarterSnapshot snapshot = new AlphaStarterSnapshot(cooper, "pending");
        assertEquals("copper_signet", snapshot.cooper().visualVariantCode());
        assertEquals("pending", snapshot.silverStatus());
        assertThrows(IllegalArgumentException.class,
                () -> new AlphaStarterSnapshot(cooper, "owned"));
        assertEquals(1, AlphaStarterClient.parseInventory(new JSONObject()
                .put("ring", ring).put("rings", new JSONArray().put(ring))).size());
        assertThrows(IllegalStateException.class, () -> AlphaStarterClient.parseInventory(
                new JSONObject().put("ring", ring).put("rings", new JSONArray())));
        assertEquals(true, AlphaAuthApi.isWalletGet("/starter/inventory"));
        assertEquals(false, AlphaAuthApi.isWalletGet("/starter/claim"));
    }
}
