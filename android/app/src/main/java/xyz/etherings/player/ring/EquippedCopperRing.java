package xyz.etherings.player.ring;

import org.json.JSONException;
import org.json.JSONObject;

public final class EquippedCopperRing {
    private final CopperRing ring;
    private final String equippedAt;

    private EquippedCopperRing(CopperRing ring, String equippedAt) {
        this.ring = ring;
        this.equippedAt = equippedAt;
    }

    public static EquippedCopperRing fromJson(JSONObject json) throws JSONException {
        CopperRing ring = CopperRing.fromJson(json.getJSONObject("ring"));
        String equippedAt = json.getString("equippedAt").trim();
        if (!ring.equipped()) throw new JSONException("equipped ring must be marked equipped");
        if (equippedAt.isEmpty()) throw new JSONException("equippedAt is required");
        return new EquippedCopperRing(ring, equippedAt);
    }

    public JSONObject toJson() {
        try {
            return new JSONObject().put("ring", ring.toJson()).put("equippedAt", equippedAt);
        } catch (JSONException error) {
            throw new IllegalStateException("Could not encode equipped Copper ring", error);
        }
    }

    public CopperRing ring() { return ring; }
    public String equippedAt() { return equippedAt; }
}
