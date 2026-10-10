package xyz.etherings.player.alpha;

import android.content.Context;
import xyz.etherings.player.BuildConfig;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class AlphaAuthApi {
    private static final Object RENEW_LOCK = new Object();
    private final String baseUrl;
    private final AlphaSessionStore sessions;

    public AlphaAuthApi(Context context, String baseUrl) {
        AlphaEndpointPolicy.requireApi(baseUrl, BuildConfig.ALPHA_DEV_API_BASE_URL);
        this.baseUrl = baseUrl;
        this.sessions = new AlphaSessionStore(context);
    }

    public Result post(String path, JSONObject body, String token) throws Exception {
        return request("POST", path, body, token);
    }

    public Result get(String path, String token) throws Exception {
        return request("GET", path, null, token);
    }

    static boolean isWalletPost(String path) {
        return path.equals("/wallet/challenge") || path.equals("/wallet/bind") ||
                path.equals("/starter/claim") || path.equals("/eru/intent") ||
                path.equals("/eru/submit") || path.equals("/eru/reconcile") ||
                path.equals("/silver/opening/preflight") ||
                path.equals("/silver/opening/candidate-intent") ||
                path.equals("/silver/opening/submit") ||
                path.equals("/silver/opening/reconcile") ||
                path.equals("/ring/equipment/equip") ||
                path.matches("/me/rings/[0-9a-f-]{36}/level-up(?:/preview|/eru/prepare)?") ||
                path.matches("/me/rings/[0-9a-f-]{36}/attribute-points/allocate") ||
                path.matches("/me/cooper/eru/(?:review|refresh|submit|status)") ||
                path.matches("/me/rings/[0-9a-f-]{36}/breeding/(?:preview|prepare)") ||
                path.matches("/me/cooper/breeding/(?:review|refresh|submit|status)") ||
                path.matches("/me/silver/[1-9A-HJ-NP-Za-km-z]{32,44}/progression/prepare") ||
                path.matches("/me/silver/progression/(?:review|refresh|submit|status)") ||
                path.matches("/me/silver/points/(?:review|refresh|submit|status)") ||
                path.matches("/me/marketplace/(?:review|refresh|submit|status)") ||
                path.matches("/me/silver/transfer/(?:review|refresh|submit|status)");
    }

    static boolean isWalletGet(String path) {
        return path.equals("/wallet") || path.equals("/wallet/assets") ||
                path.equals("/eru/history") || path.equals("/silver/inventory") ||
                path.equals("/starter/inventory") ||
                path.equals("/media/cooper/catalog") ||
                path.equals("/raffle/v2/draw") || path.equals("/raffle/v2/history") ||
                path.equals("/ring/equipment") ||
                path.equals("/me/marketplace/listings") ||
                path.matches("/me/marketplace/listing/[1-9A-HJ-NP-Za-km-z]{32,44}") ||
                path.matches("/m2e/today\\?date=\\d{4}-\\d{2}-\\d{2}") ||
                path.matches("/m2e/activity\\?from=\\d{4}-\\d{2}-\\d{2}&to=\\d{4}-\\d{2}-\\d{2}");
    }

    private Result request(String method, String path, JSONObject body, String token) throws Exception {
        boolean publicPost = method.equals("POST") && (path.equals("/auth/register") ||
                path.equals("/auth/verify") || path.equals("/auth/resend") || path.equals("/auth/login") ||
                path.equals("/auth/refresh") || path.equals("/auth/refresh-logout"));
        boolean sessionRequest = (method.equals("GET") && path.equals("/auth/me")) ||
                (method.equals("POST") && (path.equals("/auth/logout") ||
                        path.equals("/auth/reauthenticate") ||
                        path.equals("/auth/change-password")));
        boolean walletRequest = (method.equals("GET") && isWalletGet(path)) ||
                (method.equals("POST") && (isWalletPost(path) ||
                        path.equals("/raffle/v2/draw")));
        if (!publicPost && !sessionRequest && !walletRequest)
            throw new IllegalArgumentException("Unexpected Alpha API path");
        if ((sessionRequest || walletRequest) && (token == null || !token.matches("[a-f0-9]{64}"))) {
            throw new IllegalArgumentException("Invalid Alpha session");
        }
        AlphaSessionIdentity initial = token == null ? null : sessions.current();
        Result result = requestRaw(method, path, body, token);
        if (result.status != 401 || initial == null || initial.refreshToken == null ||
                !initial.token.equals(token) || path.equals("/auth/logout")) return result;
        String renewedToken = renewAfterUnauthorized(token, initial);
        if (renewedToken == null) return result;
        Result retried = requestRaw(method, path, body, renewedToken);
        if (retried.status == 401) {
            AlphaSessionIdentity current = sessions.current();
            if (current != null && current.token.equals(renewedToken)) sessions.clearIfCurrent(current);
        }
        return retried;
    }

    String renewAfterUnauthorized(String token, AlphaSessionIdentity initial) throws Exception {
        if (initial == null || initial.refreshToken == null || !initial.token.equals(token)) return null;
        synchronized (RENEW_LOCK) {
            AlphaSessionIdentity current = sessions.current();
            if (current == null || !initial.lineage.equals(current.lineage) ||
                    !initial.accountId.equals(current.accountId)) return null;
            if (current.token.equals(token)) {
                Result renewed = requestRaw("POST", "/auth/refresh", new JSONObject()
                        .put("refreshToken", current.refreshToken)
                        .put("installationId", current.installationId), null);
                if (renewed.status == 401 || renewed.status == 409) {
                    sessions.clearIfCurrent(current);
                    return null;
                }
                if (renewed.status != 200) throw new java.io.IOException("Alpha renewal unavailable");
                if (!sessions.replaceIfCurrent(current,
                        renewed.body.getString("accessToken"), renewed.body.getString("refreshToken"),
                        renewed.body.getString("refreshTokenExpiresAt"))) return null;
                current = sessions.current();
            }
            return current.token;
        }
    }

    private Result requestRaw(String method, String path, JSONObject body, String token) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(path.equals("/silver/opening/preflight") ? 60_000 : (
                path.equals("/silver/opening/candidate-intent") ||
                path.startsWith("/me/silver/points/") ||
                path.equals("/me/marketplace/listings") ||
                path.equals("/me/marketplace/review") ||
                path.equals("/me/marketplace/refresh") ||
                path.equals("/ring/equipment") ||
                path.equals("/silver/inventory") || path.equals("/wallet/assets") ||
                path.startsWith("/m2e/today?date=") ? 35_000 : 8_000));
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
        }
        try {
            int status = connection.getResponseCode();
            InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            if (stream != null) try (InputStream input = stream) {
                byte[] chunk = new byte[1024];
                int length;
                while ((length = input.read(chunk)) != -1) {
                    if (output.size() + length > responseLimit(path))
                        throw new IllegalStateException("Alpha response too large");
                    output.write(chunk, 0, length);
                }
            }
            String text = output.toString(StandardCharsets.UTF_8.name());
            return new Result(status, text.isEmpty() ? new JSONObject() : new JSONObject(text));
        } finally {
            connection.disconnect();
        }
    }

    static int responseLimit(String path) {
        return "/raffle/v2/history".equals(path) ? 524_288 : 16_384;
    }

    public static final class Result {
        public final int status;
        public final JSONObject body;
        Result(int status, JSONObject body) { this.status = status; this.body = body; }
    }
}
