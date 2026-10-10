package xyz.etherings.player.ring;

import org.json.JSONException;
import org.json.JSONObject;

public final class CopperAttributeAllocation {
    public static final int MAX_POINTS = 76;

    private final int comfort;
    private final int charm;
    private final int quality;
    private final int luck;

    public CopperAttributeAllocation(int comfort, int charm, int quality, int luck) {
        long total = (long) comfort + charm + quality + luck;
        if (!validAttributePoints(comfort) || !validAttributePoints(charm)
                || !validAttributePoints(quality) || !validAttributePoints(luck)
                || total < 1 || total > MAX_POINTS) {
            throw new IllegalArgumentException("A confirmation requires one to 76 non-negative points");
        }
        this.comfort = comfort;
        this.charm = charm;
        this.quality = quality;
        this.luck = luck;
    }

    public JSONObject toJson() throws JSONException {
        return new JSONObject().put("comfort", comfort).put("charm", charm)
                .put("quality", quality).put("luck", luck);
    }

    public int total() { return comfort + charm + quality + luck; }
    public int comfort() { return comfort; }
    public int charm() { return charm; }
    public int quality() { return quality; }
    public int luck() { return luck; }

    private static boolean validAttributePoints(int value) {
        return value >= 0 && value <= MAX_POINTS;
    }
}
