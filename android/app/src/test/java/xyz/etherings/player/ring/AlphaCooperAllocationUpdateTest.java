package xyz.etherings.player.ring;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import java.util.Arrays;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class AlphaCooperAllocationUpdateTest {
    private final String id = "e8ca2515-6bf8-4fab-8d3e-7a767c539822";
    private final String key = "d6a12c69-7db9-4a2f-bb7e-9606925fbb91";
    private final CopperAttributeAllocation allocation = new CopperAttributeAllocation(1, 2, 0, 0);

    private CopperRing ring() throws Exception {
        return CopperRing.fromJson(CopperRingTest.ringJson(id, true));
    }

    private JSONObject response(CopperRing ring) throws Exception {
        return new JSONObject().put("operationId", "8d6b0f60-e741-4fa0-83ee-9ae1bd1d8659")
                .put("rulesVersion", "copper-attribute-allocation-v2").put("ringId", id)
                .put("idempotencyKey", key).put("allocation", allocation.toJson())
                .put("attributes", new JSONObject().put("previous", ring.toJson().getJSONObject("attributes"))
                        .put("current", ring.toJson().getJSONObject("attributes")
                                .put("comfort", ring.comfort() + 1).put("charm", ring.charm() + 2)))
                .put("unspentAttributePoints", new JSONObject().put("previous", 8).put("spent", 3).put("current", 5));
    }

    private void rejected(CopperRing ring, JSONObject response) throws Exception {
        try {
            AlphaCooperAllocationUpdate.apply(new AlphaStarterSnapshot(ring, "confirmed"), ring,
                    allocation, key, response);
            fail("Unsafe response accepted");
        } catch (org.json.JSONException expected) { }
    }

    @Test public void updatesOnlyConfirmedItemAndPreservesBaseline() throws Exception {
        CopperRing first = ring();
        CopperRing other = CopperRing.fromJson(CopperRingTest.ringJson(key, false));
        AlphaStarterSnapshot source = new AlphaStarterSnapshot(first, "confirmed", Arrays.asList(first, other));
        AlphaStarterSnapshot updated = AlphaCooperAllocationUpdate.apply(source, first, allocation, key, response(first));
        assertEquals(3, updated.cooper().comfort());
        assertEquals(22, updated.cooper().charm());
        assertEquals(5, updated.cooper().unspentAttributePoints());
        assertSame(other, updated.findCooper(key));
        assertSame(first, source.cooper());
        assertEquals(8, first.unspentAttributePoints());
        assertEquals(first.toJson().getString("updatedAt"), updated.cooper().toJson().getString("updatedAt"));
        assertEquals("confirmed", updated.silverStatus());
    }

    @Test public void updatesNonStarterWithoutChangingStarter() throws Exception {
        CopperRing target = ring();
        CopperRing starter = CopperRing.fromJson(CopperRingTest.ringJson(key, false));
        AlphaStarterSnapshot source = new AlphaStarterSnapshot(starter, "pending", Arrays.asList(starter, target));
        AlphaStarterSnapshot updated = AlphaCooperAllocationUpdate.apply(source, target, allocation, key, response(target));
        assertSame(starter, updated.cooper());
        assertEquals(5, updated.findCooper(id).unspentAttributePoints());
        assertEquals("pending", updated.silverStatus());
    }

    @Test public void rejectsWrongItemOperationKeyAndRules() throws Exception {
        CopperRing ring = ring();
        rejected(ring, response(ring).put("ringId", key));
        rejected(ring, response(ring).put("idempotencyKey", id));
        rejected(ring, response(ring).put("rulesVersion", "unknown"));
        rejected(ring, response(ring).put("operationId", "unknown"));
    }

    @Test public void rejectsStaleAndInconsistentAttributes() throws Exception {
        CopperRing ring = ring();
        JSONObject body = response(ring);
        body.getJSONObject("attributes").getJSONObject("previous").put("comfort", 99);
        rejected(ring, body);
        body = response(ring);
        body.getJSONObject("attributes").getJSONObject("current").put("quality", 99);
        rejected(ring, body);
        body = response(ring);
        body.getJSONObject("allocation").put("charm", 1);
        rejected(ring, body);
    }

    @Test public void rejectsPointMismatchAndLossyNumbers() throws Exception {
        CopperRing ring = ring();
        for (Object invalid : new Object[]{4, -1, 5.5, "5", 4294967301L}) {
            JSONObject body = response(ring);
            body.getJSONObject("unspentAttributePoints").put("current", invalid);
            rejected(ring, body);
        }
        JSONObject body = response(ring);
        body.getJSONObject("unspentAttributePoints").put("spent", 2);
        rejected(ring, body);
    }

    @Test public void rejectsUnknownOutcomeAndReplacedBaseline() throws Exception {
        CopperRing ring = ring();
        rejected(ring, new JSONObject().put("status", "unknown"));
        try {
            AlphaCooperAllocationUpdate.apply(new AlphaStarterSnapshot(ring(), "confirmed"), ring,
                    allocation, key, response(ring));
            fail("Replaced baseline accepted");
        } catch (org.json.JSONException expected) { }
    }

    @Test public void replayCannotSpendPointsAgain() throws Exception {
        CopperRing ring = ring();
        JSONObject body = response(ring);
        AlphaStarterSnapshot next = AlphaCooperAllocationUpdate.apply(
                new AlphaStarterSnapshot(ring, "confirmed"), ring, allocation, key, body);
        rejected(next.cooper(), body);
    }
}
