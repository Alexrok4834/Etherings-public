package xyz.etherings.player.update;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Locale;
import java.util.regex.Pattern;

public final class AppRelease {
    public static final String METADATA_URL =
            "https://app.etherings.xyz/download/android/release.json";
    public static final String APK_URL =
            "https://app.etherings.xyz/download/android/etherings.apk";

    private static final Pattern SHA_256 = Pattern.compile("[0-9a-fA-F]{64}");
    private static final int MAX_DISPLAY_VERSION_LENGTH = 64;

    private final int versionCode;
    private final String displayVersion;
    private final boolean required;
    private final String downloadUrl;
    private final long sizeBytes;
    private final String sha256;

    private AppRelease(int versionCode, String displayVersion, boolean required,
            String downloadUrl, long sizeBytes, String sha256) {
        this.versionCode = versionCode;
        this.displayVersion = displayVersion;
        this.required = required;
        this.downloadUrl = downloadUrl;
        this.sizeBytes = sizeBytes;
        this.sha256 = sha256;
    }

    public static AppRelease fromJson(JSONObject json) throws JSONException {
        long rawVersionCode = requireInteger(json, "versionCode");
        String displayVersion = requireString(json, "displayVersion").trim();
        Object requiredValue = json.get("required");
        if (!(requiredValue instanceof Boolean)) {
            throw new JSONException("Invalid required");
        }
        boolean required = (Boolean) requiredValue;
        String downloadUrl = requireString(json, "downloadUrl").trim();
        long sizeBytes = requireInteger(json, "sizeBytes");
        String sha256 = requireString(json, "sha256").trim();

        if (rawVersionCode <= 0 || rawVersionCode > Integer.MAX_VALUE) {
            throw new JSONException("Invalid versionCode");
        }
        if (displayVersion.isEmpty() || displayVersion.length() > MAX_DISPLAY_VERSION_LENGTH) {
            throw new JSONException("Invalid displayVersion");
        }
        if (!APK_URL.equals(downloadUrl)) {
            throw new JSONException("Untrusted downloadUrl");
        }
        if (sizeBytes <= 0) {
            throw new JSONException("Invalid sizeBytes");
        }
        if (!SHA_256.matcher(sha256).matches()) {
            throw new JSONException("Invalid sha256");
        }

        return new AppRelease(
                (int) rawVersionCode,
                displayVersion,
                required,
                downloadUrl,
                sizeBytes,
                sha256.toLowerCase(Locale.ROOT)
        );
    }

    private static String requireString(JSONObject json, String key) throws JSONException {
        Object value = json.get(key);
        if (!(value instanceof String)) throw new JSONException("Invalid " + key);
        return (String) value;
    }

    private static long requireInteger(JSONObject json, String key) throws JSONException {
        Object value = json.get(key);
        if (!(value instanceof Number)) throw new JSONException("Invalid " + key);
        double doubleValue = ((Number) value).doubleValue();
        long longValue = ((Number) value).longValue();
        if (!Double.isFinite(doubleValue) || doubleValue != longValue) {
            throw new JSONException("Invalid " + key);
        }
        return longValue;
    }

    public JSONObject toJson() throws JSONException {
        return new JSONObject()
                .put("versionCode", versionCode)
                .put("displayVersion", displayVersion)
                .put("required", required)
                .put("downloadUrl", downloadUrl)
                .put("sizeBytes", sizeBytes)
                .put("sha256", sha256);
    }

    public boolean isNewerThan(int installedVersionCode) {
        return versionCode > installedVersionCode;
    }

    public boolean matchesArtifact(long candidateSizeBytes, String candidateSha256) {
        return sizeBytes == candidateSizeBytes
                && candidateSha256 != null
                && sha256.equals(candidateSha256.trim().toLowerCase(Locale.ROOT));
    }

    public int versionCode() { return versionCode; }
    public String displayVersion() { return displayVersion; }
    public boolean required() { return required; }
    public String downloadUrl() { return downloadUrl; }
    public long sizeBytes() { return sizeBytes; }
    public String sha256() { return sha256; }
}
