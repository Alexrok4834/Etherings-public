package xyz.etherings.player.ring;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

public final class CopperRing {
    private final String id;
    private final String ringKind;
    private final String status;
    private final int level;
    private final int shine;
    private final int comfort;
    private final int charm;
    private final int quality;
    private final int luck;
    private final int unspentAttributePoints;
    private final String visualVariantCode;
    private final String visualSetVersion;
    private final String rulesetVersion;
    private final boolean equipped;
    private final String createdAt;
    private final String updatedAt;

    private CopperRing(
            String id,
            String ringKind,
            String status,
            int level,
            int shine,
            int comfort,
            int charm,
            int quality,
            int luck,
            int unspentAttributePoints,
            String visualVariantCode,
            String visualSetVersion,
            String rulesetVersion,
            boolean equipped,
            String createdAt,
            String updatedAt
    ) {
        this.id = id;
        this.ringKind = ringKind;
        this.status = status;
        this.level = level;
        this.shine = shine;
        this.comfort = comfort;
        this.charm = charm;
        this.quality = quality;
        this.luck = luck;
        this.unspentAttributePoints = unspentAttributePoints;
        this.visualVariantCode = visualVariantCode;
        this.visualSetVersion = visualSetVersion;
        this.rulesetVersion = rulesetVersion;
        this.equipped = equipped;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    public static CopperRing fromJson(JSONObject json) throws JSONException {
        String id = requiredString(json, "id");
        try {
            UUID.fromString(id);
        } catch (IllegalArgumentException error) {
            throw new JSONException("id must be a UUID");
        }
        String ringKind = requiredString(json, "ringKind");
        String status = requiredString(json, "status");
        int level = json.getInt("level");
        int shine = json.getInt("shine");
        JSONObject attributes = json.getJSONObject("attributes");
        int comfort = nonNegative(attributes, "comfort");
        int charm = nonNegative(attributes, "charm");
        int quality = nonNegative(attributes, "quality");
        int luck = nonNegative(attributes, "luck");
        int unspentAttributePoints = nonNegative(json, "unspentAttributePoints");
        if (unspentAttributePoints > 76) throw new JSONException("unspentAttributePoints must be from 0 to 76");

        if (!"COPPER".equals(ringKind)) throw new JSONException("ringKind must be COPPER");
        if (!"ACTIVE".equals(status)) throw new JSONException("status must be ACTIVE");
        if (level < 1 || level > 20) throw new JSONException("level must be from 1 to 20");
        if (shine < 0 || shine > 100) throw new JSONException("shine must be from 0 to 100");

        String visualVariantCode = requiredString(json, "visualVariantCode");
        String visualSetVersion = requiredString(json, "visualSetVersion");
        String rulesetVersion = requiredString(json, "rulesetVersion");
        if (!CopperRingVisualCatalog.supports(visualVariantCode)) {
            throw new JSONException("visualVariantCode is not supported");
        }
        if (!CopperRingVisualCatalog.VISUAL_SET_VERSION.equals(visualSetVersion)) {
            throw new JSONException("visualSetVersion is not supported");
        }
        if (!CopperRingVisualCatalog.RULESET_VERSION.equals(rulesetVersion)) {
            throw new JSONException("rulesetVersion is not supported");
        }

        return new CopperRing(
                id,
                ringKind,
                status,
                level,
                shine,
                comfort,
                charm,
                quality,
                luck,
                unspentAttributePoints,
                visualVariantCode,
                visualSetVersion,
                rulesetVersion,
                json.getBoolean("equipped"),
                requiredString(json, "createdAt"),
                requiredString(json, "updatedAt")
        );
    }

    public JSONObject toJson() {
        try {
            return new JSONObject()
                    .put("id", id)
                    .put("ringKind", ringKind)
                    .put("status", status)
                    .put("level", level)
                    .put("shine", shine)
                    .put("attributes", new JSONObject()
                            .put("comfort", comfort)
                            .put("charm", charm)
                            .put("quality", quality)
                            .put("luck", luck))
                    .put("unspentAttributePoints", unspentAttributePoints)
                    .put("visualVariantCode", visualVariantCode)
                    .put("visualSetVersion", visualSetVersion)
                    .put("rulesetVersion", rulesetVersion)
                    .put("equipped", equipped)
                    .put("createdAt", createdAt)
                    .put("updatedAt", updatedAt);
        } catch (JSONException error) {
            throw new IllegalStateException("Could not encode Copper ring", error);
        }
    }

    private static String requiredString(JSONObject json, String key) throws JSONException {
        String value = json.getString(key).trim();
        if (value.isEmpty() || "null".equalsIgnoreCase(value)) throw new JSONException(key + " is required");
        return value;
    }

    private static int nonNegative(JSONObject json, String key) throws JSONException {
        int value = json.getInt(key);
        if (value < 0) throw new JSONException(key + " must be non-negative");
        return value;
    }

    public String id() { return id; }
    public String ringKind() { return ringKind; }
    public String status() { return status; }
    public int level() { return level; }
    public int shine() { return shine; }
    public int comfort() { return comfort; }
    public int charm() { return charm; }
    public int quality() { return quality; }
    public int luck() { return luck; }
    public int unspentAttributePoints() { return unspentAttributePoints; }
    public String visualVariantCode() { return visualVariantCode; }
    public String visualSetVersion() { return visualSetVersion; }
    public String rulesetVersion() { return rulesetVersion; }
    public boolean equipped() { return equipped; }
    public String createdAt() { return createdAt; }
    public String updatedAt() { return updatedAt; }
}
