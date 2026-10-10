package xyz.etherings.player.alpha;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.Base64;
import java.util.UUID;
import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.alpha.wallet.AlphaWallet;

/** Session-bound, review/refresh-before-sign adapter for canonical Devnet M. */
public final class AlphaMarketplaceClient {
    private AlphaMarketplaceClient() { }
    private static final String PENDING_PREFS = "alpha-marketplace-pending";

    public static JSONObject pending(Context context) throws Exception {
        session(context);
        String raw = context.getSharedPreferences(PENDING_PREFS, Context.MODE_PRIVATE)
                .getString("operation", null);
        if (raw == null) return null;
        JSONObject operation = new JSONObject(raw);
        AlphaWallet wallet = new AlphaWallet(context);
        return wallet.exists() && wallet.address().equals(
                operation.optString("walletAddress")) ? operation : null;
    }

    public static void clearPending(Context context) {
        context.getSharedPreferences(PENDING_PREFS, Context.MODE_PRIVATE)
                .edit().remove("operation").commit();
    }

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
        if (result.status != 200) throw new IllegalStateException(
                marketplaceError(result.status, result.body));
        return result.body;
    }

    static String marketplaceError(int status, JSONObject body) {
        String notice = AlphaSilverCooldownNotice.forResponse(status, body);
        if (notice != null) return notice;
        return body.optString("code", "Marketplace unavailable");
    }

    private static JSONObject get(Context context, String path) throws Exception {
        String token = session(context);
        AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get(path, token);
        if (!token.equals(session(context))) throw new IllegalStateException("Alpha session changed");
        if (result.status != 200) throw new IllegalStateException(
                result.body.optString("code", "Marketplace unavailable"));
        return result.body;
    }

    public static JSONObject listings(Context context) throws Exception {
        return get(context, "/me/marketplace/listings");
    }

    public static JSONObject listingOrNull(Context context, String mint) throws Exception {
        String token = session(context);
        AlphaAuthApi.Result result = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/me/marketplace/listing/" + mint, token);
        if (!token.equals(session(context))) throw new IllegalStateException("Alpha session changed");
        if (result.status == 404 &&
                "MARKETPLACE_LISTING_NOT_FOUND".equals(result.body.optString("code")))
            return null;
        if (result.status != 200) throw new IllegalStateException(
                result.body.optString("code", "Marketplace unavailable"));
        return result.body.getJSONObject("listing");
    }

    public static String boundWallet(Context context) throws Exception {
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

    public static JSONObject review(Context context, String action, String mint,
            String priceLamports, String operationId) throws Exception {
        UUID.fromString(operationId);
        JSONObject request = new JSONObject().put("action", action)
                .put("mintAddress", mint).put("operationId", operationId);
        if ("LIST".equals(action)) request.put("priceLamports", priceLamports);
        return post(context, "/me/marketplace/review", request);
    }

    public static JSONObject refresh(Context context, JSONObject approved) throws Exception {
        return post(context, "/me/marketplace/refresh",
                new JSONObject().put("approved", approved));
    }

    public static JSONObject submit(Context context, JSONObject refreshed,
            byte[] signature) throws Exception {
        try {
            JSONObject request = refreshed.getJSONObject("request");
            JSONObject operation = new JSONObject()
                    .put("operationId", request.getString("operationId"))
                    .put("action", request.getString("action"))
                    .put("mintAddress", request.getString("mintAddress"))
                    .put("walletAddress", boundWallet(context));
            SharedPreferences preferences = context.getSharedPreferences(
                    PENDING_PREFS, Context.MODE_PRIVATE);
            JSONObject prior = pending(context);
            if (prior != null && !prior.getString("operationId").equals(
                    operation.getString("operationId")))
                throw new IllegalStateException("Check pending Marketplace operation first");
            if (!preferences.edit().putString("operation", operation.toString()).commit())
                throw new IllegalStateException("Cannot preserve pending Marketplace operation");
            return post(context, "/me/marketplace/submit",
                    new JSONObject().put("refreshed", refreshed).put("userSignatureBase64",
                            Base64.getEncoder().encodeToString(signature)));
        } finally { Arrays.fill(signature, (byte) 0); }
    }

    public static JSONObject status(Context context, String operationId) throws Exception {
        return post(context, "/me/marketplace/status",
                new JSONObject().put("operationId", operationId));
    }

    public static byte[] signReviewed(Context context, JSONObject approved,
            JSONObject refreshed, String action, String mint) throws Exception {
        AlphaWallet wallet = new AlphaWallet(context);
        if (!wallet.exists()) throw new IllegalStateException("Bound wallet unavailable");
        String bound = wallet.address();
        String token = session(context);
        AlphaAuthApi.Result binding = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/wallet", token);
        if (binding.status != 200 ||
                !bound.equals(binding.body.getString("walletAddress")) ||
                !token.equals(session(context)))
            throw new IllegalStateException("Bound wallet changed");
        byte[] message = MarketplaceWalletPolicy.approvedMessage(
                approved, refreshed, bound, mint, action);
        try { return wallet.signSilverProgressionMessage(message, bound); }
        finally { Arrays.fill(message, (byte) 0); }
    }
}
