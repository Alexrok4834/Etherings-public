package xyz.etherings.player.raffle;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.regex.Pattern;

import xyz.etherings.player.sync.EtheringsDatabase;

public final class RafflePendingDrawStore {
    private static final Pattern UUID_V4 = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static final Pattern ERROR_CODE = Pattern.compile("[A-Z][A-Z0-9_]{1,63}");
    private static final int MAX_SNAPSHOT_CHARS = 262_144;

    private final RafflePendingDrawDao dao;

    public RafflePendingDrawStore(EtheringsDatabase database) {
        this(database.rafflePendingDrawDao());
    }

    RafflePendingDrawStore(RafflePendingDrawDao dao) {
        this.dao = dao;
    }

    public RafflePendingDrawEntity get(String ownerId) {
        requireUuid(ownerId, "ownerId");
        return dao.get(ownerId);
    }

    public void createSubmitting(String ownerId, String configurationVersion,
            String idempotencyKey, long nowMs) {
        requireUuid(ownerId, "ownerId");
        requireUuid(configurationVersion, "configurationVersion");
        requireUuid(idempotencyKey, "idempotencyKey");
        requireTime(nowMs);
        dao.insert(new RafflePendingDrawEntity(ownerId, "raffle-v2", configurationVersion,
                idempotencyKey, RafflePendingDrawState.SUBMITTING, null, null, nowMs, nowMs));
    }

    public void recoverInterruptedSubmission(String ownerId, String key, long nowMs) {
        requireTransition(dao.markUncertain(requireUuid(ownerId, "ownerId"),
                requireUuid(key, "idempotencyKey"), requireTime(nowMs)), "SUBMITTING -> UNCERTAIN");
    }

    public void storeCompleted(String ownerId, String key, String responseSnapshot, long nowMs) {
        requireSnapshot(responseSnapshot);
        requireTransition(dao.storeCompleted(requireUuid(ownerId, "ownerId"),
                requireUuid(key, "idempotencyKey"), responseSnapshot, requireTime(nowMs)),
                "pending -> COMPLETED_UNREVEALED");
    }

    public void markTerminalRejected(String ownerId, String key, String errorCode, long nowMs) {
        if (errorCode == null || !ERROR_CODE.matcher(errorCode).matches()) {
            throw new IllegalArgumentException("terminal error code is invalid");
        }
        requireTransition(dao.markTerminalRejected(requireUuid(ownerId, "ownerId"),
                requireUuid(key, "idempotencyKey"), errorCode, requireTime(nowMs)),
                "pending -> TERMINAL_REJECTED");
    }

    public void markRevealed(String ownerId, String key, long nowMs) {
        requireTransition(dao.markRevealed(requireUuid(ownerId, "ownerId"),
                requireUuid(key, "idempotencyKey"), requireTime(nowMs)),
                "COMPLETED_UNREVEALED -> REVEALED");
    }

    public void acknowledgeCompleted(String ownerId, String key) {
        requireTransition(dao.acknowledgeCompleted(requireUuid(ownerId, "ownerId"),
                requireUuid(key, "idempotencyKey")), "COMPLETED_UNREVEALED -> READY");
    }

    public void clearTerminal(String ownerId, String key) {
        requireTransition(dao.clearTerminal(requireUuid(ownerId, "ownerId"),
                requireUuid(key, "idempotencyKey")), "terminal -> READY");
    }

    private static String requireUuid(String value, String field) {
        if (value == null || !UUID_V4.matcher(value).matches()) {
            throw new IllegalArgumentException(field + " must be a lowercase UUID v4");
        }
        return value;
    }

    private static long requireTime(long value) {
        if (value <= 0) throw new IllegalArgumentException("timestamp must be positive");
        return value;
    }

    private static void requireSnapshot(String snapshot) {
        if (snapshot == null || snapshot.isEmpty() || snapshot.length() > MAX_SNAPSHOT_CHARS) {
            throw new IllegalArgumentException("response snapshot size is invalid");
        }
        try {
            JSONObject json = new JSONObject(snapshot);
            if (!"raffle-v2".equals(json.optString("contractVersion"))) {
                throw new IllegalArgumentException("response snapshot contract is invalid");
            }
        } catch (JSONException error) {
            throw new IllegalArgumentException("response snapshot must be JSON", error);
        }
    }

    private static void requireTransition(int changed, String transition) {
        if (changed != 1) throw new IllegalStateException("Invalid pending Draw transition: " + transition);
    }
}
