package xyz.etherings.player.api;

import java.net.URI;

import xyz.etherings.player.BuildConfig;

public final class ApiConfig {
    private final String baseUrl;

    public ApiConfig(String baseUrl) {
        this.baseUrl = normalizeBaseUrl(baseUrl);
    }

    public static ApiConfig fromBuildConfig() {
        return new ApiConfig(BuildConfig.ETHERINGS_API_BASE_URL);
    }

    public String baseUrl() {
        return baseUrl;
    }

    public String url(String path) {
        if (path.startsWith("/")) {
            return baseUrl + path;
        }

        return baseUrl + "/" + path;
    }

    public boolean isSecureMobileSessionTransport() {
        URI uri = URI.create(baseUrl);
        if ("https".equalsIgnoreCase(uri.getScheme())) {
            return true;
        }
        if (!"http".equalsIgnoreCase(uri.getScheme())) {
            return false;
        }
        String host = uri.getHost();
        return "localhost".equalsIgnoreCase(host)
                || "127.0.0.1".equals(host)
                || "10.0.2.2".equals(host);
    }

    private static String normalizeBaseUrl(String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("API base URL is required");
        }

        String trimmed = value.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }

        return trimmed;
    }
}
