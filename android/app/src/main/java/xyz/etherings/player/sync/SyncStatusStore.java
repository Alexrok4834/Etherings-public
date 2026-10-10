package xyz.etherings.player.sync;

import android.content.Context;
import android.content.SharedPreferences;

import xyz.etherings.player.economy.ErtValue;

public final class SyncStatusStore {
    private static final String PREFS_NAME = "etherings_sync_status_v1";
    private static final String OWNER_ID = "owner_id";
    private static final String PENDING_STEPS = "pending_steps";
    private static final String PENDING_BATCHES = "pending_batches";
    private static final String HELD_STEPS = "held_steps";
    private static final String HELD_BATCHES = "held_batches";
    private static final String SYNCED_STEPS = "synced_steps";
    private static final String SYNCED_ERT = "synced_ert";
    private static final String SYNCED_ERT_EXACT = "synced_ert_exact";
    private static final String SYNCED_ERT_DISPLAY = "synced_ert_display";
    private static final String SYNCED_BATCHES = "synced_batches";
    private static final String REJECTED_STEPS = "rejected_steps";
    private static final String REJECTED_BATCHES = "rejected_batches";
    private static final String LAST_SUCCESS_AT_MS = "last_success_at_ms";
    private static final String LAST_ATTEMPT_AT_MS = "last_attempt_at_ms";
    private static final String AUTH_REQUIRED = "auth_required";
    private static final String REVISION = "revision";

    private final SharedPreferences preferences;
    private SharedPreferences.OnSharedPreferenceChangeListener preferenceListener;

    public SyncStatusStore(Context context) {
        preferences = context.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public synchronized void save(String ownerId, SyncStatusSnapshot snapshot) {
        requireOwner(ownerId);
        if (snapshot == null) {
            throw new IllegalArgumentException("snapshot is required");
        }
        preferences.edit()
                .putString(OWNER_ID, ownerId)
                .putLong(PENDING_STEPS, snapshot.pendingSteps())
                .putInt(PENDING_BATCHES, snapshot.pendingBatches())
                .putLong(HELD_STEPS, snapshot.heldSteps())
                .putInt(HELD_BATCHES, snapshot.heldBatches())
                .putLong(SYNCED_STEPS, snapshot.syncedSteps())
                .remove(SYNCED_ERT)
                .putString(SYNCED_ERT_EXACT, snapshot.syncedErtExact())
                .putString(SYNCED_ERT_DISPLAY, snapshot.syncedErtDisplay())
                .putInt(SYNCED_BATCHES, snapshot.syncedBatches())
                .putLong(REJECTED_STEPS, snapshot.rejectedSteps())
                .putInt(REJECTED_BATCHES, snapshot.rejectedBatches())
                .putLong(LAST_SUCCESS_AT_MS, snapshot.lastSuccessfulSyncAtMs())
                .putLong(LAST_ATTEMPT_AT_MS, snapshot.lastAttemptAtMs())
                .putBoolean(AUTH_REQUIRED, snapshot.authRequired())
                .putLong(REVISION, preferences.getLong(REVISION, 0L) + 1L)
                .apply();
    }

    public synchronized void markAttempt(String ownerId, boolean authRequired, long nowMs) {
        SyncStatusSnapshot current = snapshot(ownerId);
        save(ownerId, new SyncStatusSnapshot(
                current.pendingSteps(), current.pendingBatches(), current.heldSteps(), current.heldBatches(),
                current.syncedSteps(), current.syncedErtValue(),
                current.syncedBatches(), current.rejectedSteps(), current.rejectedBatches(),
                current.lastSuccessfulSyncAtMs(), nowMs, authRequired
        ));
    }

    public synchronized void markAuthenticated(String ownerId) {
        SyncStatusSnapshot current = snapshot(ownerId);
        save(ownerId, new SyncStatusSnapshot(
                current.pendingSteps(), current.pendingBatches(), current.heldSteps(), current.heldBatches(),
                current.syncedSteps(), current.syncedErtValue(),
                current.syncedBatches(), current.rejectedSteps(), current.rejectedBatches(),
                current.lastSuccessfulSyncAtMs(), current.lastAttemptAtMs(), false
        ));
    }

    public synchronized SyncStatusSnapshot snapshot(String ownerId) {
        requireOwner(ownerId);
        if (!ownerId.equals(preferences.getString(OWNER_ID, null))) {
            return SyncStatusSnapshot.empty();
        }
        return new SyncStatusSnapshot(
                preferences.getLong(PENDING_STEPS, 0L),
                preferences.getInt(PENDING_BATCHES, 0),
                preferences.getLong(HELD_STEPS, 0L),
                preferences.getInt(HELD_BATCHES, 0),
                preferences.getLong(SYNCED_STEPS, 0L),
                readSyncedErt(),
                preferences.getInt(SYNCED_BATCHES, 0),
                preferences.getLong(REJECTED_STEPS, 0L),
                preferences.getInt(REJECTED_BATCHES, 0),
                preferences.getLong(LAST_SUCCESS_AT_MS, 0L),
                preferences.getLong(LAST_ATTEMPT_AT_MS, 0L),
                preferences.getBoolean(AUTH_REQUIRED, false)
        );
    }

    private ErtValue readSyncedErt() {
        String exact = preferences.getString(SYNCED_ERT_EXACT, null);
        String display = preferences.getString(SYNCED_ERT_DISPLAY, null);
        if (exact != null || display != null) {
            try {
                return ErtValue.fromExactAndDisplay(exact, display);
            } catch (IllegalArgumentException ignored) {
                return ErtValue.zero();
            }
        }
        long legacy = Math.max(0L, preferences.getLong(SYNCED_ERT, 0L));
        return ErtValue.fromExact(Long.toString(legacy));
    }

    public void startListening(Runnable listener) {
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        stopListening();
        preferenceListener = (sharedPreferences, key) -> {
            if (REVISION.equals(key)) {
                listener.run();
            }
        };
        preferences.registerOnSharedPreferenceChangeListener(preferenceListener);
    }

    public void stopListening() {
        if (preferenceListener == null) {
            return;
        }
        preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener);
        preferenceListener = null;
    }

    private void requireOwner(String ownerId) {
        if (ownerId == null || ownerId.trim().isEmpty()) {
            throw new IllegalArgumentException("ownerId is required");
        }
    }
}
