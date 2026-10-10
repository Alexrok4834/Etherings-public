package xyz.etherings.player.update;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

public final class AppUpdateStore {
    private static final String PREFS = "app_update_check";
    private static final String RELEASE_JSON = "release_json";
    private static final String SUCCESS_AT = "success_at";
    private static final String FAILURE_COUNT = "failure_count";
    private static final String RETRY_AT = "retry_at";
    private static final String DISMISSED_VERSION = "dismissed_version";
    private static final String DISMISSED_AT = "dismissed_at";

    private final SharedPreferences preferences;

    public AppUpdateStore(Context context) {
        preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public AppRelease freshCachedRelease(long nowMs) {
        if (!UpdateCheckPolicy.isFresh(
                nowMs, preferences.getLong(SUCCESS_AT, 0L), UpdateCheckPolicy.SUCCESS_CACHE_MS)) {
            return null;
        }
        String raw = preferences.getString(RELEASE_JSON, null);
        if (raw == null) return null;
        try {
            return AppRelease.fromJson(new JSONObject(raw));
        } catch (JSONException error) {
            preferences.edit().remove(RELEASE_JSON).remove(SUCCESS_AT).apply();
            return null;
        }
    }

    public boolean shouldCheckNetwork(long nowMs) {
        if (freshCachedRelease(nowMs) != null) return false;
        return nowMs >= preferences.getLong(RETRY_AT, 0L);
    }

    public void recordSuccess(AppRelease release, long nowMs) throws JSONException {
        preferences.edit()
                .putString(RELEASE_JSON, release.toJson().toString())
                .putLong(SUCCESS_AT, nowMs)
                .putInt(FAILURE_COUNT, 0)
                .remove(RETRY_AT)
                .apply();
    }

    public void recordFailure(long nowMs) {
        int count = Math.min(preferences.getInt(FAILURE_COUNT, 0) + 1, 8);
        preferences.edit()
                .putInt(FAILURE_COUNT, count)
                .putLong(RETRY_AT, nowMs + UpdateCheckPolicy.failureBackoffMs(count))
                .apply();
    }

    public boolean shouldPrompt(AppRelease release, int installedVersionCode, long nowMs) {
        if (!release.isNewerThan(installedVersionCode)) return false;
        if (preferences.getInt(DISMISSED_VERSION, -1) != release.versionCode()) return true;
        long duration = release.required()
                ? UpdateCheckPolicy.REQUIRED_DISMISS_MS
                : UpdateCheckPolicy.OPTIONAL_DISMISS_MS;
        return !UpdateCheckPolicy.isFresh(
                nowMs, preferences.getLong(DISMISSED_AT, 0L), duration);
    }

    public void recordDismissed(AppRelease release, long nowMs) {
        preferences.edit()
                .putInt(DISMISSED_VERSION, release.versionCode())
                .putLong(DISMISSED_AT, nowMs)
                .apply();
    }
}
