package xyz.etherings.player.walk;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

public final class PendingWalkSubmissionStore {
    private static final String PREFS_NAME = "etherings_walk_submission_v1";
    private static final String PENDING_SUBMISSION = "pending_submission";

    private final SharedPreferences preferences;

    public PendingWalkSubmissionStore(Context context) {
        this.preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public synchronized void save(WalkSubmissionDraft draft) throws JSONException {
        if (draft == null) {
            clear();
            return;
        }

        preferences.edit()
                .putString(PENDING_SUBMISSION, draft.toJson().toString())
                .apply();
    }

    public synchronized WalkSubmissionDraft load() {
        String raw = preferences.getString(PENDING_SUBMISSION, null);
        if (raw == null || raw.trim().isEmpty()) {
            return null;
        }

        try {
            return WalkSubmissionDraft.fromJson(new JSONObject(raw));
        } catch (JSONException ignored) {
            return null;
        }
    }

    public synchronized void clear() {
        preferences.edit()
                .remove(PENDING_SUBMISSION)
                .apply();
    }
}
