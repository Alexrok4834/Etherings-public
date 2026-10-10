package xyz.etherings.alpha;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

final class AlphaApi {
    private final String baseUrl;

    AlphaApi(String baseUrl) {
        if (baseUrl == null || !baseUrl.equals("http://127.0.0.1:19081")) {
            throw new IllegalArgumentException("Alpha dev endpoint is unavailable");
        }
        this.baseUrl = baseUrl;
    }

    Result post(String path, JSONObject body, String token) throws Exception {
        return request("POST", path, body, token);
    }

    Result get(String path, String token) throws Exception {
        return request("GET", path, null, token);
    }

    private Result request(String method, String path, JSONObject body, String token) throws Exception {
        if (!path.startsWith("/auth/") && !path.equals("/wallet") &&
                !path.equals("/wallet/challenge") && !path.equals("/wallet/bind") &&
                !path.equals("/eru/intent") && !path.equals("/eru/submit") &&
                !path.equals("/eru/reconcile") &&
                !(BuildConfig.DEBUG && (path.equals("/silver/opening/candidate-intent") ||
                        (method.equals("GET") && path.equals("/silver/inventory")))))
            throw new IllegalArgumentException("Unexpected Alpha API path");
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(8_000);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setUseCaches(false);
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
                    if (output.size() + length > 16_384) throw new IllegalStateException("Alpha response too large");
                    output.write(chunk, 0, length);
                }
            }
            String text = output.toString(StandardCharsets.UTF_8.name());
            return new Result(status, text.isEmpty() ? new JSONObject() : new JSONObject(text));
        } finally {
            connection.disconnect();
        }
    }

    static final class Result {
        final int status;
        final JSONObject body;
        Result(int status, JSONObject body) { this.status = status; this.body = body; }
    }
}
