package xyz.etherings.player.alpha;

import android.content.Context;
import android.os.Bundle;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Base64;

import xyz.etherings.player.BuildConfig;
import xyz.etherings.player.ring.SilverInventorySnapshot;
import xyz.etherings.player.ring.SilverOpeningReadiness;
import xyz.etherings.player.alpha.wallet.AlphaWallet;

public final class AlphaSilverInventoryClient {
    private AlphaSilverInventoryClient() { }

    public static SilverInventorySnapshot load(Context context) throws Exception {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        String token = sessions.load();
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        AlphaAuthApi.Result response = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .get("/silver/inventory", token);
        if (!token.equals(sessions.load())) throw new IllegalStateException("Alpha session changed");
        if (response.status != 200) throw new IllegalStateException("Silver inventory unavailable");
        return SilverInventorySnapshot.parse(response.body);
    }

    public static SilverOpeningReadiness checkOpening(Context context, String mint) throws Exception {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        String token = sessions.load();
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        AlphaAuthApi.Result response = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL)
                .post("/silver/opening/preflight", new JSONObject().put("mintAddress", mint), token);
        if (!token.equals(sessions.load()) || response.status != 200)
            throw new IllegalStateException("Silver opening unavailable");
        return SilverOpeningReadiness.parse(response.body, mint,
                BuildConfig.ALPHA_SILVER_OPENING_SIGN_ENABLED);
    }

    public static Bundle reviewOpening(Context context, String mint, String escrow) throws Exception {
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        String token = sessions.load();
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        AlphaWallet wallet = new AlphaWallet(context);
        if (!wallet.exists()) throw new IllegalStateException("Bound wallet unavailable");
        AlphaAuthApi api = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL);
        AlphaAuthApi.Result binding = api.get("/wallet", token);
        String authority = wallet.address();
        if (binding.status != 200 || !authority.equals(binding.body.getString("walletAddress")))
            throw new IllegalStateException("Bound wallet mismatch");
        AlphaAuthApi.Result candidate = api.post("/silver/opening/candidate-intent",
                new JSONObject().put("mintAddress", mint), token);
        if (!token.equals(sessions.load()) || candidate.status != 200)
            throw new IllegalStateException("Silver opening candidate unavailable");
        SilverOpeningPolicy policy = SilverOpeningPolicy.forReview(candidate.body, authority,
                mint, escrow, BuildConfig.ALPHA_SILVER_PROGRAM_ID);
        SilverOpeningPolicy.Decoded decoded = policy.validateResponse(candidate.body);
        if (!decoded.blockhash.equals(candidate.body.getString("blockhash")))
            throw new IllegalArgumentException("Silver opening blockhash mismatch");
        new SilverOpeningChainClock(BuildConfig.ALPHA_SILVER_RPC_URL).requireCurrent(policy,
                decoded, candidate.body.getLong("lastValidBlockHeight"));
        if (!token.equals(sessions.load()) || !authority.equals(wallet.address()))
            throw new IllegalStateException("Silver review account changed");
        Bundle review = new Bundle();
        review.putString("candidate", candidate.body.toString());
        review.putString("mint", mint);
        review.putString("escrow", escrow);
        review.putString("wallet", authority);
        review.putString("sessionHash", hash(token));
        review.putString("display", "Devnet Box opening review\nBox: " + decoded.mint +
                "\nWallet: " + decoded.authority + "\nEscrow: " + decoded.escrow +
                "\nORAO request: " + decoded.request +
                "\nNetwork fee: Devnet SOL\n" +
                (BuildConfig.ALPHA_SILVER_OPENING_SIGN_ENABLED ?
                        "Box moves to escrow until the same request is finalized." :
                        "Opening is not enabled."));
        return review;
    }

    public static String signOpening(Context context, Bundle review) {
        String[] stage = { "config" };
        try { return signOpeningChecked(context, review, stage); }
        catch (Exception error) {
            if ("chain".equals(stage[0])) {
                String reason = error.getMessage();
                if ("Silver opening blockhash expired".equals(reason))
                    return "rejected before signing (blockhash expired)";
                if ("Silver opening chain accounts changed".equals(reason))
                    return "rejected before signing (chain accounts changed)";
                if ("Silver opening Box state changed".equals(reason))
                    return "rejected before signing (Box state changed)";
                if ("Silver opening PDA mismatch".equals(reason))
                    return "rejected before signing (PDA mismatch)";
                if ("Silver opening RPC unavailable".equals(reason))
                    return "rejected before signing (RPC unavailable)";
            }
            return "post-sign".equals(stage[0]) ? "unknown" :
                    "rejected before signing (" + stage[0] + ")";
        }
    }

    private static String signOpeningChecked(Context context, Bundle review,
            String[] stage) throws Exception {
        if (!BuildConfig.ALPHA_SILVER_OPENING_SIGN_ENABLED || review == null)
            throw new IllegalStateException("Silver signing disabled");
        stage[0] = "session";
        AlphaSessionStore sessions = new AlphaSessionStore(context);
        String token = sessions.load();
        if (token == null || !hash(token).equals(review.getString("sessionHash")))
            throw new IllegalStateException("Silver session changed");
        String mint = review.getString("mint"), escrow = review.getString("escrow");
        String authority = review.getString("wallet");
        AlphaWallet wallet = new AlphaWallet(context);
        if (!wallet.exists() || !authority.equals(wallet.address()))
            throw new IllegalStateException("Bound Silver wallet changed");
        AlphaAuthApi api = new AlphaAuthApi(context, BuildConfig.ALPHA_DEV_API_BASE_URL);
        stage[0] = "binding";
        AlphaAuthApi.Result binding = api.get("/wallet", token);
        if (binding.status != 200 || !authority.equals(binding.body.getString("walletAddress")))
            throw new IllegalStateException("Silver wallet binding changed");
        stage[0] = "prior";
        AlphaAuthApi.Result prior = api.post("/silver/opening/reconcile",
                new JSONObject().put("mintAddress", mint), token);
        if (prior.status != 404 || prior.body.has("status"))
            throw new IllegalStateException("Silver opening already submitted");
        stage[0] = "refresh";
        Bundle fresh = reviewOpening(context, mint, escrow);
        if (!authority.equals(fresh.getString("wallet")) ||
                !review.getString("sessionHash").equals(fresh.getString("sessionHash")) ||
                !review.getString("display").equals(fresh.getString("display")))
            throw new IllegalStateException("Silver opening review changed");
        JSONObject candidate = new JSONObject(fresh.getString("candidate"));
        SilverOpeningPolicy policy = SilverOpeningPolicy.forReview(candidate, authority,
                mint, escrow, BuildConfig.ALPHA_SILVER_PROGRAM_ID);
        SilverOpeningPolicy.Decoded decoded = policy.validateResponse(candidate);
        if (!decoded.blockhash.equals(candidate.getString("blockhash")))
            throw new IllegalArgumentException("Silver opening blockhash changed");
        stage[0] = "chain";
        SilverOpeningChainClock clock = new SilverOpeningChainClock(BuildConfig.ALPHA_SILVER_RPC_URL);
        clock.requireCurrent(policy, decoded, candidate.getLong("lastValidBlockHeight"));
        if (!hash(sessions.load()).equals(review.getString("sessionHash")) ||
                !authority.equals(wallet.address()))
            throw new IllegalStateException("Silver review or session changed");
        stage[0] = "wallet-core";
        byte[] signature = wallet.signSilverOpening(candidate, policy, authority);
        stage[0] = "post-sign";
        try {
            if (!hash(sessions.load()).equals(review.getString("sessionHash")))
                throw new IllegalStateException("Silver session changed after signing");
            JSONObject payload = new JSONObject().put("mintAddress", mint)
                    .put("messageBase64", candidate.getString("messageBase64"))
                    .put("blockhash", decoded.blockhash)
                    .put("lastValidBlockHeight", candidate.getLong("lastValidBlockHeight"))
                    .put("signatureBase64", Base64.getEncoder().encodeToString(signature));
            try {
                AlphaAuthApi.Result sent = api.post("/silver/opening/submit", payload, token);
                if (sent.body.has("status") &&
                        !"unknown".equals(sent.body.getString("status")))
                    return sent.body.getString("status");
                if (sent.status == 409) return "rejected before broadcast";
            } catch (Exception ignored) { /* The backend may already hold the signed operation. */ }
            for (int attempt = 0; attempt < 30; attempt++) {
                Thread.sleep(1000);
                AlphaAuthApi.Result observed = api.post("/silver/opening/reconcile",
                        new JSONObject().put("mintAddress", mint), token);
                if (observed.body.has("status") &&
                        !"unknown".equals(observed.body.getString("status")))
                    return observed.body.getString("status");
            }
            return "unknown";
        } finally { Arrays.fill(signature, (byte) 0); }
    }

    private static String hash(String token) throws Exception {
        if (token == null) throw new IllegalStateException("Alpha session unavailable");
        byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(token.getBytes(StandardCharsets.US_ASCII));
        return Base64.getEncoder().encodeToString(digest);
    }
}
