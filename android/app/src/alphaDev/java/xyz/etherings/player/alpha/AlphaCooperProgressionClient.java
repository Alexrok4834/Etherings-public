package xyz.etherings.player.alpha;

import android.content.Context;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.wallet.AlphaWallet;

/** Alpha account adapter for the existing Cooper progression UI. */
public final class AlphaCooperProgressionClient {
    private AlphaCooperProgressionClient() { }

    private static String token(Context context) {
        String value = new AlphaSessionStore(context).load();
        if (value == null) throw new IllegalStateException("Alpha session unavailable");
        return value;
    }

    private static JSONObject post(Context context, String path, JSONObject request) throws Exception {
        AlphaSessionIdentity expected = new AlphaSessionStore(context).current();
        String session = token(context);
        AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .post(path, request, session);
        if (!new AlphaSessionStore(context).sameLineage(expected))
            throw new IllegalStateException("Alpha session changed");
        if (result.status != 200) throw new IllegalStateException(
                result.body.optString("code", "Cooper progression unavailable"));
        return result.body;
    }

    public static JSONObject preview(Context context, String ringId, int current) throws Exception {
        return post(context, "/me/rings/" + ringId + "/level-up/preview",
                new JSONObject().put("expectedCurrentLevel", current).put("targetLevel", current + 1));
    }

    public static JSONObject levelUp(Context context, String ringId, int current,
            String idempotencyKey) throws Exception {
        return post(context, "/me/rings/" + ringId + "/level-up",
                levelRequest(current, idempotencyKey));
    }

    public static JSONObject allocate(Context context, String ringId, int expected,
            int comfort, int charm, int quality, int luck, String idempotencyKey) throws Exception {
        if (comfort > 0) AlphaM2eComfortBoundary.close(context);
        return post(context, "/me/rings/" + ringId + "/attribute-points/allocate",
                new JSONObject().put("expectedUnspentPoints", expected)
                        .put("allocation", new JSONObject().put("comfort", comfort)
                                .put("charm", charm).put("quality", quality).put("luck", luck))
                        .put("idempotencyKey", idempotencyKey));
    }

    public static JSONObject prepare(Context context, String ringId, int current,
            String idempotencyKey) throws Exception {
        return post(context, "/me/rings/" + ringId + "/level-up/eru/prepare",
                levelRequest(current, idempotencyKey));
    }

    public static JSONObject review(Context context, String operationId) throws Exception {
        return action(context, "review", new JSONObject().put("operationId", operationId));
    }

    public static JSONObject refresh(Context context, String operationId, JSONObject approved) throws Exception {
        return action(context, "refresh", new JSONObject().put("operationId", operationId)
                .put("approved", approved));
    }

    public static JSONObject submit(Context context, String operationId, JSONObject refreshed,
            byte[] signature) throws Exception {
        try {
            return action(context, "submit", new JSONObject().put("operationId", operationId)
                    .put("refreshed", refreshed)
                    .put("userSignatureBase64", Base64.getEncoder().encodeToString(signature)));
        } finally { Arrays.fill(signature, (byte) 0); }
    }

    public static JSONObject status(Context context, String operationId) throws Exception {
        return action(context, "status", new JSONObject().put("operationId", operationId));
    }

    public static byte[] signReviewed(Context context, JSONObject approved,
            JSONObject refreshed, String ringId, int current) throws Exception {
        AlphaWallet wallet = new AlphaWallet(context);
        if (!wallet.exists()) throw new IllegalStateException("Bound wallet unavailable");
        String bound = wallet.address();
        AlphaSessionIdentity expected = new AlphaSessionStore(context).current();
        String session = token(context);
        AlphaAuthApi.Result binding = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/wallet", session);
        if (binding.status != 200 || !bound.equals(binding.body.getString("walletAddress")) ||
                !new AlphaSessionStore(context).sameLineage(expected))
            throw new IllegalStateException("Bound wallet changed");
        byte[] message = CooperEruPolicy.approvedMessage(approved, refreshed, ringId, current, bound);
        try { return wallet.signCooperEruMessage(message, bound); }
        finally { Arrays.fill(message, (byte) 0); }
    }

    private static JSONObject action(Context context, String action, JSONObject body) throws Exception {
        return post(context, "/me/cooper/eru/" + action, body);
    }

    private static JSONObject levelRequest(int current, String idempotencyKey) throws Exception {
        UUID.fromString(idempotencyKey);
        return new JSONObject().put("expectedCurrentLevel", current)
                .put("targetLevel", current + 1).put("idempotencyKey", idempotencyKey);
    }
}
