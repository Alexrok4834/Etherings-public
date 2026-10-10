package xyz.etherings.player.home;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

public final class HomeProfileStore {
    private static final String PREFS_NAME = "etherings_home_profile_v1";
    private static final String OWNER_ID = "owner_id";
    private static final String PROFILE_JSON = "profile_json";

    private final SharedPreferences preferences;

    public HomeProfileStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public void save(HomeProfile profile) {
        if (profile == null || profile.userId().isEmpty()) {
            throw new IllegalArgumentException("profile with owner identity is required");
        }
        preferences.edit()
                .putString(OWNER_ID, profile.userId())
                .putString(PROFILE_JSON, profile.toJson().toString())
                .apply();
    }

    public HomeProfile snapshot(String ownerId) {
        if (ownerId == null || !ownerId.equals(preferences.getString(OWNER_ID, null))) {
            return null;
        }
        String encoded = preferences.getString(PROFILE_JSON, null);
        if (encoded == null) {
            return null;
        }
        try {
            HomeProfile profile = HomeProfile.fromJson(new JSONObject(encoded));
            return ownerId.equals(profile.userId()) ? profile : null;
        } catch (JSONException | RuntimeException ignored) {
            return null;
        }
    }
}
