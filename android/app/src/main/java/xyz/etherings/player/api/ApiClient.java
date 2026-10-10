package xyz.etherings.player.api;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class ApiClient {
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 20_000;

    private final ApiConfig config;

    public ApiClient(ApiConfig config) {
        this.config = config;
    }

    public JSONObject postJson(String path, JSONObject body, String accessToken) throws IOException, JSONException, ApiException {
        return new JSONObject(request("POST", path, body, accessToken));
    }

    public JSONObject getJson(String path, String accessToken) throws IOException, JSONException, ApiException {
        return new JSONObject(request("GET", path, null, accessToken));
    }

    public JSONArray getJsonArray(String path, String accessToken) throws IOException, JSONException, ApiException {
        return new JSONArray(request("GET", path, null, accessToken));
    }

    public void postNoContent(String path, JSONObject body) throws IOException, ApiException {
        request("POST", path, body, null);
    }

    private String request(String method, String path, JSONObject body, String accessToken) throws IOException, ApiException {
        HttpURLConnection connection = (HttpURLConnection) new URL(config.url(path)).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setRequestProperty("Accept", "application/json");

        if (accessToken != null && !accessToken.isEmpty()) {
            connection.setRequestProperty("Authorization", "Bearer " + accessToken);
        }

        if (body != null) {
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            try (BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(connection.getOutputStream(), StandardCharsets.UTF_8))) {
                writer.write(body.toString());
            }
        }

        int statusCode = connection.getResponseCode();
        String responseBody = readBody(statusCode >= 400 ? connection.getErrorStream() : connection.getInputStream());
        connection.disconnect();

        if (statusCode < 200 || statusCode >= 300) {
            throw new ApiException(statusCode, responseBody);
        }

        return responseBody;
    }

    private static String readBody(InputStream inputStream) throws IOException {
        if (inputStream == null) {
            return "";
        }

        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(inputStream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                result.append(line);
            }
        }

        return result.toString();
    }
}
