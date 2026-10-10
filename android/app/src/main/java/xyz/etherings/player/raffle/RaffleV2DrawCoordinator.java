package xyz.etherings.player.raffle;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.UUID;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;
import xyz.etherings.player.auth.SessionExpiredException;

public final class RaffleV2DrawCoordinator {
    public enum Kind { COMPLETED, UNCERTAIN, TERMINAL_REJECTED, SESSION_REQUIRED }

    public static final class Result {
        private final Kind kind;
        private final String idempotencyKey;
        private final String responseSnapshot;
        private final String errorCode;
        private final boolean replayed;
        private final RaffleV2SelectionEvidence evidence;

        private Result(Kind kind, String key, String snapshot, String errorCode, boolean replayed,
                RaffleV2SelectionEvidence evidence) {
            this.kind = kind;
            this.idempotencyKey = key;
            this.responseSnapshot = snapshot;
            this.errorCode = errorCode;
            this.replayed = replayed;
            this.evidence = evidence;
        }

        static Result completed(String key, String snapshot, boolean replayed,
                RaffleV2SelectionEvidence evidence) {
            return new Result(Kind.COMPLETED, key, snapshot, null, replayed, evidence);
        }
        static Result uncertain(String key) {
            return new Result(Kind.UNCERTAIN, key, null, null, false, null);
        }
        static Result terminal(String key, String code) {
            return new Result(Kind.TERMINAL_REJECTED, key, null, code, false, null);
        }
        static Result sessionRequired(String key) {
            return new Result(Kind.SESSION_REQUIRED, key, null, "SESSION_EXPIRED", false, null);
        }

        public Kind kind() { return kind; }
        public String idempotencyKey() { return idempotencyKey; }
        public String responseSnapshot() { return responseSnapshot; }
        public String errorCode() { return errorCode; }
        public boolean replayed() { return replayed; }
        public RaffleV2SelectionEvidence evidence() { return evidence; }
    }

    interface KeyFactory { String create(); }
    interface Clock { long nowMs(); }

    private final RaffleV2Api api;
    private final AuthenticatedSession session;
    private final SessionCredentialStore credentials;
    private final RafflePendingDrawStore pendingStore;
    private final KeyFactory keys;
    private final Clock clock;

    public RaffleV2DrawCoordinator(RaffleV2Api api, AuthenticatedSession session,
            SessionCredentialStore credentials, RafflePendingDrawStore pendingStore) {
        this(api, session, credentials, pendingStore,
                () -> UUID.randomUUID().toString(), System::currentTimeMillis);
    }

    RaffleV2DrawCoordinator(RaffleV2Api api, AuthenticatedSession session,
            SessionCredentialStore credentials, RafflePendingDrawStore pendingStore,
            KeyFactory keys, Clock clock) {
        this.api = api;
        this.session = session;
        this.credentials = credentials;
        this.pendingStore = pendingStore;
        this.keys = keys;
        this.clock = clock;
    }

    public synchronized Result submitOrResume(RaffleV2Draw currentDraw) {
        SessionCredentials saved;
        try {
            saved = credentials.getCredentials();
        } catch (GeneralSecurityException error) {
            credentials.clear();
            return Result.sessionRequired(null);
        }
        if (saved == null) return Result.sessionRequired(null);

        String ownerId = saved.ownerId();
        RafflePendingDrawEntity pending = pendingStore.get(ownerId);
        if (pending != null) {
            if (pending.state == RafflePendingDrawState.COMPLETED_UNREVEALED
                    || pending.state == RafflePendingDrawState.REVEALED) {
                return completedFromStored(pending);
            }
            if (pending.state == RafflePendingDrawState.TERMINAL_REJECTED) {
                return Result.terminal(pending.idempotencyKey, pending.terminalErrorCode);
            }
            if (pending.state == RafflePendingDrawState.SUBMITTING) {
                pendingStore.recoverInterruptedSubmission(ownerId, pending.idempotencyKey, now());
                pending = pendingStore.get(ownerId);
            }
        } else {
            if (currentDraw == null) throw new IllegalArgumentException("currentDraw is required for a new Draw");
            String key = keys.create();
            pendingStore.createSubmitting(ownerId, currentDraw.configurationVersion(), key, now());
            pending = pendingStore.get(ownerId);
        }

        final RafflePendingDrawEntity operation = pending;
        JSONObject request = new JSONObject();
        try {
            request.put("contractVersion", operation.contractVersion);
            request.put("configurationVersion", operation.configurationVersion);
            request.put("idempotencyKey", operation.idempotencyKey);
            JSONObject response = session.execute(token -> api.executeDraw(request, token));
            RaffleV2CommandResponse parsed = RaffleV2CommandResponse.parse(response,
                    operation.configurationVersion, operation.idempotencyKey);
            pendingStore.storeCompleted(ownerId, operation.idempotencyKey, parsed.snapshot(), now());
            return Result.completed(operation.idempotencyKey, parsed.snapshot(), parsed.replayed(),
                    parsed.evidence());
        } catch (SessionExpiredException | GeneralSecurityException error) {
            markUncertainIfSubmitting(ownerId, operation.idempotencyKey);
            return Result.sessionRequired(operation.idempotencyKey);
        } catch (ApiException error) {
            String code = stableCode(error);
            if (isTerminalNoCharge(error.statusCode(), code)) {
                pendingStore.markTerminalRejected(ownerId, operation.idempotencyKey, code, now());
                return Result.terminal(operation.idempotencyKey, code);
            }
            markUncertainIfSubmitting(ownerId, operation.idempotencyKey);
            return Result.uncertain(operation.idempotencyKey);
        } catch (IOException | JSONException | RuntimeException error) {
            markUncertainIfSubmitting(ownerId, operation.idempotencyKey);
            return Result.uncertain(operation.idempotencyKey);
        }
    }

    private Result completedFromStored(RafflePendingDrawEntity pending) {
        try {
            RaffleV2CommandResponse parsed = RaffleV2CommandResponse.parse(
                    new JSONObject(pending.responseSnapshot), pending.configurationVersion,
                    pending.idempotencyKey);
            return Result.completed(pending.idempotencyKey, parsed.snapshot(), parsed.replayed(),
                    parsed.evidence());
        } catch (JSONException | RuntimeException error) {
            return Result.uncertain(pending.idempotencyKey);
        }
    }

    private void markUncertainIfSubmitting(String ownerId, String key) {
        RafflePendingDrawEntity latest = pendingStore.get(ownerId);
        if (latest != null && latest.state == RafflePendingDrawState.SUBMITTING) {
            pendingStore.recoverInterruptedSubmission(ownerId, key, now());
        }
    }

    private static String stableCode(ApiException error) {
        try {
            Object value = new JSONObject(error.responseBody()).opt("code");
            return value instanceof String ? (String) value : null;
        } catch (JSONException ignored) {
            return null;
        }
    }

    private static boolean isTerminalNoCharge(int status, String code) {
        if (status == 400) return "RAFFLE_REQUEST_INVALID".equals(code);
        if (status == 404) return "RAFFLE_UNAVAILABLE".equals(code);
        if (status != 409) return false;
        return "RAFFLE_CONFIGURATION_STALE".equals(code)
                || "RAFFLE_IDEMPOTENCY_CONFLICT".equals(code)
                || "RAFFLE_INSUFFICIENT_ERT".equals(code)
                || "RAFFLE_DAILY_LIMIT_REACHED".equals(code)
                || "RAFFLE_NO_ELIGIBLE_REWARD".equals(code);
    }

    private long now() {
        long value = clock.nowMs();
        if (value <= 0) throw new IllegalStateException("clock must return a positive timestamp");
        return value;
    }
}
