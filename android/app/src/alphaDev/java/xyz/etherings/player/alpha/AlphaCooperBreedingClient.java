package xyz.etherings.player.alpha;

import android.content.Context;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.wallet.AlphaWallet;

/** Alpha adapter for one approved Cooper breeding intent; no local price authority. */
public final class AlphaCooperBreedingClient {
    private AlphaCooperBreedingClient() { }

    private static String token(Context context) {
        String value = new AlphaSessionStore(context).load();
        if (value == null) throw new IllegalStateException("Alpha session unavailable");
        return value;
    }

    private static JSONObject post(Context context, String path, JSONObject body) throws Exception {
        AlphaSessionIdentity expected = new AlphaSessionStore(context).current();
        String session = token(context);
        AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .post(path, body, session);
        if (!new AlphaSessionStore(context).sameLineage(expected))
            throw new IllegalStateException("Alpha session changed");
        if (result.status != 200) throw new IllegalStateException(
                result.body.optString("code", "Cooper breeding unavailable"));
        return result.body;
    }

    public static JSONObject preview(Context context, String firstId, String secondId)
            throws Exception {
        UUID.fromString(firstId); UUID.fromString(secondId);
        return post(context, "/me/rings/" + firstId + "/breeding/preview",
                new JSONObject().put("secondRingId", secondId));
    }

    public static JSONObject prepare(Context context, String firstId, String secondId,
            String idempotencyKey) throws Exception {
        UUID.fromString(firstId); UUID.fromString(secondId); UUID.fromString(idempotencyKey);
        return post(context, "/me/rings/" + firstId + "/breeding/prepare",
                new JSONObject().put("secondRingId", secondId)
                        .put("idempotencyKey", idempotencyKey));
    }

    public static JSONObject review(Context context, String operationId) throws Exception {
        return action(context, "review", new JSONObject().put("operationId", operationId));
    }

    public static JSONObject refresh(Context context, String operationId, JSONObject approved)
            throws Exception {
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
            JSONObject refreshed, String firstId, String secondId) throws Exception {
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
        byte[] message = CooperBreedingPolicy.approvedMessage(approved, refreshed,
                firstId, secondId, bound);
        try { return wallet.signCooperEruMessage(message, bound); }
        finally { Arrays.fill(message, (byte) 0); }
    }

    private static JSONObject action(Context context, String name, JSONObject body)
            throws Exception {
        return post(context, "/me/cooper/breeding/" + name, body);
    }
}
