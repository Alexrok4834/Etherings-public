package xyz.etherings.player.alpha;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import org.json.JSONObject;
import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.wallet.AlphaWallet;

/** Bound-wallet Silver Send; no Marketplace authority or generic signing API. */
public final class AlphaSilverDirectTransferClient {
    private static final String PENDING = "alpha-silver-direct-transfer-pending";
    private AlphaSilverDirectTransferClient() { }

    private static String session(Context context) {
        String token = new AlphaSessionStore(context).load();
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        return token;
    }

    private static JSONObject post(Context context, String action, JSONObject body) throws Exception {
        String token = session(context);
        AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .post("/me/silver/transfer/" + action, body, token);
        if (!token.equals(session(context))) throw new IllegalStateException("Alpha session changed");
        if (result.status != 200) throw new IllegalStateException(
                result.body.optString("code", "Silver Send unavailable"));
        return result.body;
    }

    static String boundWallet(Context context) throws Exception {
        AlphaWallet wallet = new AlphaWallet(context);
        String token = session(context);
        AlphaAuthApi.Result binding = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/wallet", token);
        if (!wallet.exists() || binding.status != 200 ||
                !wallet.address().equals(binding.body.getString("walletAddress")) ||
                !token.equals(session(context)))
            throw new IllegalStateException("Bound wallet changed");
        return wallet.address();
    }

    static JSONObject pending(Context context) throws Exception {
        String raw = context.getSharedPreferences(PENDING, Context.MODE_PRIVATE)
                .getString("operation", null);
        if (raw == null) return null;
        JSONObject value = new JSONObject(raw);
        return boundWallet(context).equals(value.optString("walletAddress")) ? value : null;
    }

    static void clearPending(Context context) {
        context.getSharedPreferences(PENDING, Context.MODE_PRIVATE)
                .edit().remove("operation").commit();
    }

    static JSONObject review(Context context, String mint, String recipient,
            String operationId) throws Exception {
        UUID.fromString(operationId);
        return post(context, "review", new JSONObject().put("mintAddress", mint)
                .put("recipientAddress", recipient).put("operationId", operationId));
    }

    static JSONObject refresh(Context context, JSONObject approved) throws Exception {
        return post(context, "refresh", new JSONObject().put("approved", approved));
    }

    static JSONObject submit(Context context, JSONObject refreshed, byte[] signature) throws Exception {
        try {
            JSONObject request = refreshed.getJSONObject("request");
            JSONObject operation = new JSONObject().put("operationId",
                    request.getString("operationId"))
                    .put("walletAddress", boundWallet(context))
                    .put("mintAddress", request.getString("mintAddress"))
                    .put("refreshed", refreshed)
                    .put("userSignatureBase64", Base64.getEncoder().encodeToString(signature));
            JSONObject prior = pending(context);
            if (prior != null && !prior.getString("operationId").equals(
                    operation.getString("operationId")))
                throw new IllegalStateException("Check pending Silver Send first");
            SharedPreferences prefs = context.getSharedPreferences(PENDING, Context.MODE_PRIVATE);
            if (!prefs.edit().putString("operation", operation.toString()).commit())
                throw new IllegalStateException("Cannot preserve pending Silver Send");
            return post(context, "submit", new JSONObject().put("refreshed", refreshed)
                    .put("userSignatureBase64", Base64.getEncoder().encodeToString(signature)));
        } finally { Arrays.fill(signature, (byte) 0); }
    }

    static JSONObject status(Context context, String operationId) throws Exception {
        return post(context, "status", new JSONObject().put("operationId", operationId));
    }

    static void retryExactPending(Context context, JSONObject operation) throws Exception {
        if (!boundWallet(context).equals(operation.getString("walletAddress")))
            throw new IllegalStateException("Bound wallet changed");
        JSONObject refreshed = operation.getJSONObject("refreshed");
        if (!operation.getString("operationId").equals(
                refreshed.getJSONObject("request").getString("operationId")) ||
                !operation.getString("mintAddress").equals(
                refreshed.getJSONObject("request").getString("mintAddress")))
            throw new IllegalStateException("Pending Silver Send changed");
        post(context, "submit", new JSONObject().put("refreshed", refreshed)
                .put("userSignatureBase64", operation.getString("userSignatureBase64")));
    }

    static byte[] signReviewed(Context context, JSONObject approved,
            JSONObject refreshed, String mint, String recipient) throws Exception {
        String walletAddress = boundWallet(context);
        byte[] message = SilverDirectTransferWalletPolicy.approvedMessage(
                approved, refreshed, walletAddress, mint, recipient);
        try { return new AlphaWallet(context).signSilverProgressionMessage(
                message, walletAddress); }
        finally { Arrays.fill(message, (byte) 0); }
    }
}
