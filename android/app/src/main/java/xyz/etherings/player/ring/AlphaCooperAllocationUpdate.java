package xyz.etherings.player.ring;

import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Projects a committed allocation response onto its exact in-memory baseline. */
public final class AlphaCooperAllocationUpdate {
    private AlphaCooperAllocationUpdate() { }

    public static AlphaStarterSnapshot apply(AlphaStarterSnapshot source, CopperRing before,
            CopperAttributeAllocation requested, String key, JSONObject response) throws JSONException {
        if (source == null || source.findCooper(before.id()) != before)
            throw new JSONException("Cooper baseline changed");
        if (!"copper-attribute-allocation-v2".equals(response.getString("rulesVersion")) ||
                !before.id().equals(response.getString("ringId")) ||
                !key.equals(response.getString("idempotencyKey")))
            throw new JSONException("Allocation identity mismatch");
        String operation = response.getString("operationId");
        try {
            if (!UUID.fromString(operation).toString().equalsIgnoreCase(operation))
                throw new IllegalArgumentException();
        } catch (IllegalArgumentException error) { throw new JSONException("Invalid operation identity"); }
        JSONObject attrs = response.getJSONObject("attributes");
        JSONObject previous = attrs.getJSONObject("previous");
        JSONObject current = attrs.getJSONObject("current");
        JSONObject allocation = response.getJSONObject("allocation");
        String[] names = {"comfort", "charm", "quality", "luck"};
        int[] old = {before.comfort(), before.charm(), before.quality(), before.luck()};
        int[] delta = {requested.comfort(), requested.charm(), requested.quality(), requested.luck()};
        for (int i = 0; i < names.length; i++) {
            if (integer(previous, names[i]) != old[i] || integer(allocation, names[i]) != delta[i] ||
                    integer(current, names[i]) != (long) old[i] + delta[i])
                throw new JSONException("Allocation attributes mismatch");
        }
        JSONObject points = response.getJSONObject("unspentAttributePoints");
        int remaining = integer(points, "current");
        if (integer(points, "previous") != before.unspentAttributePoints() ||
                integer(points, "spent") != requested.total() ||
                remaining != before.unspentAttributePoints() - requested.total())
            throw new JSONException("Allocation point balance mismatch");
        // No fabricated update timestamp, equipment decision, M2E result or NFT state.
        CopperRing updated = CopperRing.fromJson(before.toJson()
                .put("attributes", new JSONObject(current.toString()))
                .put("unspentAttributePoints", remaining));
        List<CopperRing> rings = new ArrayList<>();
        for (CopperRing ring : source.coopers()) rings.add(ring == before ? updated : ring);
        return new AlphaStarterSnapshot(source.cooper().id().equals(before.id()) ? updated : source.cooper(),
                source.silverStatus(), rings);
    }

    private static int integer(JSONObject object, String field) throws JSONException {
        Object value = object.get(field);
        if (!(value instanceof Integer || value instanceof Long) ||
                ((Number) value).longValue() < 0 || ((Number) value).longValue() > Integer.MAX_VALUE)
            throw new JSONException("Invalid integer: " + field);
        return ((Number) value).intValue();
    }
}
