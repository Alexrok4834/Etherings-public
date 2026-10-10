package xyz.etherings.player.ring;

import org.json.JSONException;
import org.json.JSONObject;

public final class CopperAttributeAllocationResult {
    private final String operationId;
    private final int comfort;
    private final int charm;
    private final int quality;
    private final int luck;
    private final int unspentAttributePoints;

    private CopperAttributeAllocationResult(
            String operationId, int comfort, int charm, int quality, int luck, int unspentAttributePoints
    ) {
        this.operationId = operationId;
        this.comfort = comfort;
        this.charm = charm;
        this.quality = quality;
        this.luck = luck;
        this.unspentAttributePoints = unspentAttributePoints;
    }

    public static CopperAttributeAllocationResult fromJson(JSONObject json) throws JSONException {
        JSONObject current = json.getJSONObject("attributes").getJSONObject("current");
        return new CopperAttributeAllocationResult(
                json.getString("operationId"),
                current.getInt("comfort"),
                current.getInt("charm"),
                current.getInt("quality"),
                current.getInt("luck"),
                json.getJSONObject("unspentAttributePoints").getInt("current")
        );
    }

    public String operationId() { return operationId; }
    public int comfort() { return comfort; }
    public int charm() { return charm; }
    public int quality() { return quality; }
    public int luck() { return luck; }
    public int unspentAttributePoints() { return unspentAttributePoints; }
}
