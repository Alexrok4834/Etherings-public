package xyz.etherings.player.raffle;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.regex.Pattern;

final class RaffleV2CommandResponse {
    private static final Pattern UUID_V4 = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");

    private final String snapshot;
    private final boolean replayed;
    private final RaffleV2SelectionEvidence evidence;

    private RaffleV2CommandResponse(String snapshot, boolean replayed,
            RaffleV2SelectionEvidence evidence) {
        this.snapshot = snapshot;
        this.replayed = replayed;
        this.evidence = evidence;
    }

    static RaffleV2CommandResponse parse(JSONObject root, String expectedConfiguration,
            String expectedKey) throws JSONException {
        if (!"raffle-v2".equals(root.optString("contractVersion"))) {
            throw new JSONException("Unsupported Raffle command contract");
        }
        JSONObject operation = root.getJSONObject("operation");
        requireUuid(operation.getString("operationId"), "operationId");
        if (!expectedKey.equals(operation.optString("idempotencyKey"))) {
            throw new JSONException("Raffle operation key does not match");
        }
        if (!"COMPLETED".equals(operation.optString("status"))) {
            throw new JSONException("Raffle operation is not completed");
        }
        Object replayedValue = operation.get("replayed");
        if (!(replayedValue instanceof Boolean)) {
            throw new JSONException("Raffle replay marker is invalid");
        }
        JSONObject draw = root.getJSONObject("draw");
        requireUuid(draw.getString("drawResultId"), "drawResultId");
        requireUuid(draw.getString("drawId"), "drawId");
        if (!expectedConfiguration.equals(draw.optString("configurationVersion"))) {
            throw new JSONException("Raffle configuration does not match");
        }
        draw.getJSONObject("cost");
        draw.getJSONObject("attempts");
        RaffleV2SelectionEvidence evidence = RaffleV2SelectionEvidence.parse(
                root.getJSONObject("selection"), root.getJSONObject("reward"),
                root.getJSONObject("fulfillment"), draw.getString("drawResultId"));
        return new RaffleV2CommandResponse(root.toString(), (Boolean) replayedValue, evidence);
    }

    String snapshot() { return snapshot; }
    boolean replayed() { return replayed; }
    RaffleV2SelectionEvidence evidence() { return evidence; }

    private static void requireUuid(String value, String field) throws JSONException {
        if (!UUID_V4.matcher(value).matches()) throw new JSONException(field + " must be a UUID v4");
    }
}
