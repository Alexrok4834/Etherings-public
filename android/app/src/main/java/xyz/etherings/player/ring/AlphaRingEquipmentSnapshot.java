package xyz.etherings.player.ring;

import org.json.JSONObject;

import java.math.BigInteger;

/** A transient view of the account selection; never an ownership or media authority. */
public final class AlphaRingEquipmentSnapshot {
    private static final String UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    private static final String MINT = "[1-9A-HJ-NP-Za-km-z]{32,44}";

    public static final class Key {
        public final String kind;
        public final String id;

        private Key(String kind, String id) { this.kind = kind; this.id = id; }

        public boolean matches(String otherKind, String otherId) {
            return kind.equals(otherKind) && id.equals(otherId);
        }

        public JSONObject json() throws Exception {
            return new JSONObject().put("kind", kind).put("id", id);
        }
    }

    public final Key selection;
    public final String version;
    public final String eligibility;
    public final boolean effectsEnabled;

    private AlphaRingEquipmentSnapshot(Key selection, String version, String eligibility,
            boolean effectsEnabled) {
        this.selection = selection;
        this.version = version;
        this.eligibility = eligibility;
        this.effectsEnabled = effectsEnabled;
    }

    public static Key key(String kind, String id) {
        if ("COOPER".equals(kind) && id != null && id.matches(UUID)) return new Key(kind, id);
        if ("SILVER_RING".equals(kind) && id != null && id.matches(MINT)) return new Key(kind, id);
        throw new IllegalArgumentException("Invalid Ring selection key");
    }

    public static AlphaRingEquipmentSnapshot parse(JSONObject body) throws Exception {
        JSONObject selected = body.getJSONObject("selection");
        Key key = key(selected.getString("kind"), selected.getString("id"));
        String version = body.getString("version");
        if (!version.matches("[1-9][0-9]*") ||
                new BigInteger(version).compareTo(BigInteger.valueOf(Long.MAX_VALUE)) > 0)
            throw new IllegalArgumentException("Invalid Ring selection version");
        String eligibility = body.getString("eligibility");
        if (!("ELIGIBLE".equals(eligibility) || "UNKNOWN".equals(eligibility)) ||
                !(body.get("effectsEnabled") instanceof Boolean))
            throw new IllegalArgumentException("Invalid Ring eligibility");
        boolean enabled = body.getBoolean("effectsEnabled");
        if (enabled != "ELIGIBLE".equals(eligibility) ||
                ("COOPER".equals(key.kind) && !enabled))
            throw new IllegalArgumentException("Inconsistent Ring eligibility");
        return new AlphaRingEquipmentSnapshot(key, version, eligibility, enabled);
    }
}
