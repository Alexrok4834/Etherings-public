package xyz.etherings.player.alpha;

import android.content.Context;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.wallet.AlphaWallet;

/** Bound Alpha wallet adapter for on-chain Silver progression. */
public final class AlphaSilverProgressionClient {
    private AlphaSilverProgressionClient() { }

    private static String session(Context context) {
        String value = new AlphaSessionStore(context).load();
        if (value == null) throw new IllegalStateException("Alpha session unavailable");
        return value;
    }

    private static JSONObject post(Context context, String path, JSONObject body) throws Exception {
        String token = session(context);
        AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .post(path, body, token);
        if (!token.equals(session(context))) throw new IllegalStateException("Alpha session changed");
        if (result.status != 200) {
            String cooldownNotice = AlphaSilverCooldownNotice.forResponse(
                    result.status, result.body);
            if (cooldownNotice != null) throw new IllegalStateException(cooldownNotice);
            String code = result.body.optString("code", "Silver progression unavailable");
            throw new IllegalStateException("SILVER_RING_LISTED".equals(code) ?
                    "Unlist this Silver Ring before Level-Up or Points allocation." :
                    "SILVER_SOL_INSUFFICIENT".equals(code) ?
                    "Add Devnet SOL to your wallet for the network fee and Ring update, then retry." : code);
        }
        return result.body;
    }

    public static JSONObject prepare(Context context, String mint, int current,
            String idempotencyKey) throws Exception {
        UUID.fromString(idempotencyKey);
        return post(context, "/me/silver/" + mint + "/progression/prepare",
                new JSONObject().put("expectedCurrentLevel", current)
                        .put("targetLevel", current + 1)
                        .put("idempotencyKey", idempotencyKey));
    }

    public static JSONObject review(Context context, String operationId) throws Exception {
        return action(context, "review", new JSONObject().put("operationId", operationId));
    }

    public static JSONObject refresh(Context context, String operationId,
            JSONObject approved) throws Exception {
        return action(context, "refresh", new JSONObject().put("operationId", operationId)
                .put("approved", approved));
    }

    public static JSONObject submit(Context context, String operationId,
            JSONObject refreshed, byte[] signature) throws Exception {
        try {
            return action(context, "submit", new JSONObject().put("operationId", operationId)
                    .put("refreshed", refreshed)
                    .put("userSignatureBase64", Base64.getEncoder().encodeToString(signature)));
        } finally { Arrays.fill(signature, (byte) 0); }
    }

    public static JSONObject status(Context context, String operationId) throws Exception {
        return action(context, "status", new JSONObject().put("operationId", operationId));
    }

    public static JSONObject reviewAllocation(Context context, String mint,
            JSONObject allocation) throws Exception {
        return post(context, "/me/silver/points/review",
                new JSONObject().put("mintAddress", mint).put("allocation", allocation));
    }

    public static JSONObject refreshAllocation(Context context, JSONObject approved) throws Exception {
        return post(context, "/me/silver/points/refresh",
                new JSONObject().put("approved", approved));
    }

    public static JSONObject submitAllocation(Context context, JSONObject refreshed,
            byte[] signature) throws Exception {
        try {
            if (refreshed.getJSONObject("candidate").getJSONObject("allocation")
                    .optInt("comfort", 0) > 0)
                AlphaM2eComfortBoundary.close(context);
            return post(context, "/me/silver/points/submit",
                    new JSONObject().put("refreshed", refreshed)
                            .put("userSignatureBase64", Base64.getEncoder().encodeToString(signature)));
        } finally { Arrays.fill(signature, (byte) 0); }
    }

    public static JSONObject allocationStatus(Context context, String signature) throws Exception {
        return post(context, "/me/silver/points/status",
                new JSONObject().put("signature", signature));
    }

    public static String allocationSignature(byte[] signature) {
        if (signature == null || signature.length != 64)
            throw new IllegalArgumentException("Invalid Silver allocation signature");
        return SilverOpeningPolicy.address(signature);
    }

    public static byte[] signReviewed(Context context, JSONObject approved,
            JSONObject refreshed, String mint, int current) throws Exception {
        AlphaWallet wallet = new AlphaWallet(context);
        if (!wallet.exists()) throw new IllegalStateException("Bound wallet unavailable");
        String bound = wallet.address();
        String token = session(context);
        AlphaAuthApi.Result binding = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/wallet", token);
        if (binding.status != 200 || !bound.equals(binding.body.getString("walletAddress")) ||
                !token.equals(session(context)))
            throw new IllegalStateException("Bound wallet changed");
        byte[] message = SilverProgressionPolicy.approvedMessage(approved, refreshed,
                mint, current, bound);
        try { return wallet.signSilverProgressionMessage(message, bound); }
        finally { Arrays.fill(message, (byte) 0); }
    }

    public static byte[] signAllocationReviewed(Context context, JSONObject approved,
            JSONObject refreshed, String mint, JSONObject allocation) throws Exception {
        AlphaWallet wallet = new AlphaWallet(context);
        if (!wallet.exists()) throw new IllegalStateException("Bound wallet unavailable");
        String bound = wallet.address();
        String token = session(context);
        AlphaAuthApi.Result binding = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/wallet", token);
        if (binding.status != 200 || !bound.equals(binding.body.getString("walletAddress")) ||
                !token.equals(session(context)))
            throw new IllegalStateException("Bound wallet changed");
        byte[] message = SilverProgressionPolicy.approvedAllocationMessage(approved, refreshed,
                mint, bound, allocation);
        try { return wallet.signSilverProgressionMessage(message, bound); }
        finally { Arrays.fill(message, (byte) 0); }
    }

    private static JSONObject action(Context context, String verb, JSONObject body) throws Exception {
        return post(context, "/me/silver/progression/" + verb, body);
    }
}
