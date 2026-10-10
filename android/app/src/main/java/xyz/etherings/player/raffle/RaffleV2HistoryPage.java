package xyz.etherings.player.raffle;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class RaffleV2HistoryPage {
    private final List<String> itemSnapshots;
    private final String nextCursor;

    private RaffleV2HistoryPage(List<String> itemSnapshots, String nextCursor) {
        this.itemSnapshots = Collections.unmodifiableList(new ArrayList<>(itemSnapshots));
        this.nextCursor = nextCursor;
    }

    public static RaffleV2HistoryPage fromJson(JSONObject root) throws JSONException {
        if (!"raffle-v2".equals(root.optString("contractVersion"))) {
            throw new JSONException("Unsupported Raffle history contract version");
        }
        JSONArray items = root.getJSONArray("items");
        List<String> snapshots = new ArrayList<>();
        for (int index = 0; index < items.length(); index++) {
            JSONObject item = items.getJSONObject(index);
            RaffleV2Json.uuid(item, "operationId");
            item.getJSONObject("draw");
            item.getJSONObject("selection");
            item.getJSONObject("reward");
            item.getJSONObject("fulfillment");
            snapshots.add(item.toString());
        }
        String cursor = root.isNull("nextCursor") ? null : RaffleV2Json.text(root, "nextCursor", 512);
        return new RaffleV2HistoryPage(snapshots, cursor);
    }

    public List<String> itemSnapshots() { return itemSnapshots; }
    public String nextCursor() { return nextCursor; }
}
