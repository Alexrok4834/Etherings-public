package xyz.etherings.player.update;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public final class AppReleaseClient {
    private static final int TIMEOUT_MS = 5_000;
    private static final int MAX_RESPONSE_CHARS = 8_192;
    interface ConnectionFactory {
        HttpURLConnection open(URL url) throws IOException;
    }

    private final ConnectionFactory connectionFactory;

    public AppReleaseClient() {
        this(url -> (HttpURLConnection) url.openConnection());
    }

    AppReleaseClient(ConnectionFactory connectionFactory) {
        this.connectionFactory = connectionFactory;
    }

    public AppRelease fetch() throws IOException, JSONException {
        HttpURLConnection connection = connectionFactory.open(new URL(AppRelease.METADATA_URL));
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(TIMEOUT_MS);
        connection.setReadTimeout(TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cache-Control", "no-cache");

        try {
            int statusCode = connection.getResponseCode();
            if (statusCode != HttpURLConnection.HTTP_OK) {
                throw new IOException("Release metadata returned HTTP " + statusCode);
            }

            StringBuilder body = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(
                    connection.getInputStream(), StandardCharsets.UTF_8))) {
                char[] buffer = new char[1024];
                int count;
                while ((count = reader.read(buffer)) != -1) {
                    if (body.length() + count > MAX_RESPONSE_CHARS) {
                        throw new IOException("Release metadata is too large");
                    }
                    body.append(buffer, 0, count);
                }
            }
            return AppRelease.fromJson(new JSONObject(body.toString()));
        } finally {
            connection.disconnect();
        }
    }
}
