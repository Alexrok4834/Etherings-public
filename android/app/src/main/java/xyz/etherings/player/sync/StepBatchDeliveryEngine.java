package xyz.etherings.player.sync;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.time.Instant;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;
import xyz.etherings.player.auth.SessionExpiredException;
import xyz.etherings.player.economy.ErtValue;

public final class StepBatchDeliveryEngine {
    public enum Outcome {
        COMPLETE,
        MORE_PENDING,
        RETRY,
        AUTH_REQUIRED
    }

    private static final long STALE_IN_FLIGHT_MS = 15L * 60L * 1000L;
    private static final int MAX_BATCHES_PER_RUN = 10;

    private final StepSyncDao dao;
    private final StepBatchApi api;
    private final StepBatchDeliveryAccess access;
    private final TimeSource timeSource;
    private final StopSignal stopSignal;

    public StepBatchDeliveryEngine(
            StepSyncDao dao,
            StepBatchApi api,
            AuthenticatedSession authenticatedSession,
            SessionCredentialStore credentialStore
    ) {
        this(dao, api, authenticatedSession, credentialStore, System::currentTimeMillis, () -> false);
    }

    StepBatchDeliveryEngine(
            StepSyncDao dao,
            StepBatchApi api,
            AuthenticatedSession authenticatedSession,
            SessionCredentialStore credentialStore,
            TimeSource timeSource,
            StopSignal stopSignal
    ) {
        this(dao, api, mvpAccess(authenticatedSession, credentialStore), timeSource, stopSignal);
    }

    public StepBatchDeliveryEngine(StepSyncDao dao, StepBatchApi api, StepBatchDeliveryAccess access) {
        this(dao, api, access, System::currentTimeMillis, () -> false);
    }

    StepBatchDeliveryEngine(StepSyncDao dao, StepBatchApi api, StepBatchDeliveryAccess access,
            TimeSource timeSource, StopSignal stopSignal) {
        this.dao = dao;
        this.api = api;
        this.access = access;
        this.timeSource = timeSource;
        this.stopSignal = stopSignal;
    }

    private static StepBatchDeliveryAccess mvpAccess(AuthenticatedSession session,
            SessionCredentialStore store) {
        return new StepBatchDeliveryAccess() {
            @Override public Identity current() throws GeneralSecurityException {
                SessionCredentials credentials = store.getCredentials();
                return credentials == null ? null
                        : new Identity(credentials.ownerId(), credentials.installationId(), credentials);
            }

            @Override public JSONObject submitForOwner(String ownerId, String installationId,
                    StepBatchApi api, JSONObject payload) throws IOException, JSONException,
                    ApiException, GeneralSecurityException, SessionExpiredException {
                return session.executeForOwner(ownerId, installationId,
                        token -> api.submitStepBatch(payload, token));
            }

            @Override public void invalidateOnSecurityError(Identity identity) {
                if (identity == null) {
                    store.clear();
                    return;
                }
                try {
                    store.clearIfCurrent((SessionCredentials) identity.credentialHandle());
                } catch (GeneralSecurityException ignored) {
                    store.clear();
                }
            }
        };
    }

    public Outcome drain() {
        StepBatchDeliveryAccess.Identity identity;
        try {
            identity = access.current();
        } catch (GeneralSecurityException error) {
            access.invalidateOnSecurityError(null);
            return Outcome.AUTH_REQUIRED;
        }
        if (identity == null) {
            return Outcome.AUTH_REQUIRED;
        }

        long nowMs = timeSource.nowMs();
        dao.recoverStaleInFlightBatches(
                identity.ownerId(),
                identity.installationId(),
                nowMs - STALE_IN_FLIGHT_MS,
                nowMs
        );

        for (int index = 0; index < MAX_BATCHES_PER_RUN; index++) {
            if (stopSignal.isStopped()) {
                return Outcome.RETRY;
            }
            StepOutboxBatchEntity head = dao.getOldestUnresolvedBatch(
                    identity.ownerId(), identity.installationId());
            if (head == null) return Outcome.COMPLETE;
            if (head.state == SyncBatchState.IN_FLIGHT) return Outcome.RETRY;
            StepOutboxBatchEntity batch = dao.claimOldestReadyBatch(
                    identity.ownerId(), identity.installationId(), timeSource.nowMs());
            if (batch == null) return Outcome.RETRY;
            Outcome outcome = deliverClaimed(batch, identity);
            if (outcome != Outcome.COMPLETE) {
                return outcome;
            }
        }
        return dao.getOldestUnresolvedBatch(identity.ownerId(), identity.installationId()) != null
                ? Outcome.MORE_PENDING
                : Outcome.COMPLETE;
    }

    private Outcome deliverClaimed(StepOutboxBatchEntity batch, StepBatchDeliveryAccess.Identity identity) {
        if (!batch.ownerId.equals(identity.ownerId())
                || !batch.installationId.equals(identity.installationId())) {
            returnReady(batch);
            return Outcome.AUTH_REQUIRED;
        }

        try {
            JSONObject response = access.submitForOwner(batch.ownerId, batch.installationId,
                    api, toPayload(batch));
            return applyResponse(batch, response);
        } catch (SessionExpiredException error) {
            returnReady(batch);
            return Outcome.AUTH_REQUIRED;
        } catch (IOException | JSONException error) {
            returnReady(batch);
            return Outcome.RETRY;
        } catch (GeneralSecurityException error) {
            access.invalidateOnSecurityError(identity);
            returnReady(batch);
            return Outcome.AUTH_REQUIRED;
        } catch (ApiException error) {
            if (error.statusCode() == 503 && comfortEpochUnavailable(error.responseBody())) {
                requireUpdate(dao.holdInFlightBatch(batch.batchId, batch.ownerId,
                        "M2E_COMFORT_EPOCH_UNAVAILABLE", timeSource.nowMs()));
                return Outcome.COMPLETE;
            }
            if (error.statusCode() == 429 || error.statusCode() >= 500) {
                returnReady(batch);
                return Outcome.RETRY;
            }
            reject(batch, "HTTP_" + error.statusCode(), 0L, ErtValue.zero());
            return Outcome.COMPLETE;
        }
    }

    private boolean comfortEpochUnavailable(String body) {
        if (body == null) return false;
        try {
            return "M2E_COMFORT_EPOCH_UNAVAILABLE".equals(
                    new JSONObject(body).optString("code"));
        } catch (JSONException ignored) {
            return false;
        }
    }

    private Outcome applyResponse(StepOutboxBatchEntity batch, JSONObject response) throws JSONException {
        if (!response.has("batchId")
                || !response.has("installationId")
                || !response.has("sequence")
                || !response.has("status")) {
            returnReady(batch);
            return Outcome.RETRY;
        }
        if (!batch.batchId.equals(response.optString("batchId", ""))
                || !batch.installationId.equals(response.optString("installationId", ""))
                || batch.sequence != response.optLong("sequence", -1L)) {
            reject(batch, "LOCAL_RESPONSE_IDENTITY_MISMATCH", 0L, ErtValue.zero());
            return Outcome.COMPLETE;
        }

        String status = response.optString("status", "");
        String resultCode = response.optString("resultCode", status);
        if (("ACCEPTED".equals(status) || "PARTIALLY_ACCEPTED".equals(status))
                && hasTerminalNumbers(response)) {
            acknowledge(
                    batch,
                    resultCode,
                    response.optLong("acceptedStepDelta"),
                    responseErt(response)
            );
            return Outcome.COMPLETE;
        }
        if ("REJECTED".equals(status) && hasTerminalNumbers(response)) {
            reject(
                    batch,
                    resultCode,
                    response.optLong("acceptedStepDelta"),
                    responseErt(response)
            );
            return Outcome.COMPLETE;
        }

        returnReady(batch);
        return Outcome.RETRY;
    }

    private boolean hasTerminalNumbers(JSONObject response) {
        return response.has("acceptedStepDelta")
                && !response.isNull("acceptedStepDelta")
                && ((response.has("earnedErtDeltaExact")
                        && !response.isNull("earnedErtDeltaExact")
                        && response.has("earnedErtDeltaDisplay")
                        && !response.isNull("earnedErtDeltaDisplay"))
                    || (response.has("earnedErtDelta") && !response.isNull("earnedErtDelta")));
    }

    private ErtValue responseErt(JSONObject response) throws JSONException {
        ErtValue value = ErtValue.fromJson(
                response,
                "earnedErtDeltaExact",
                "earnedErtDeltaDisplay",
                "earnedErtDelta"
        );
        try {
            value.wholeUnitsFloor();
        } catch (IllegalStateException error) {
            throw new JSONException("earned ERT delta exceeds the installed-client compatibility range");
        }
        return value;
    }

    private JSONObject toPayload(StepOutboxBatchEntity batch) throws JSONException {
        return new JSONObject()
                .put("installationId", batch.installationId)
                .put("batchId", batch.batchId)
                .put("sequence", batch.sequence)
                .put("localDate", batch.localDate)
                .put("timezoneOffsetMinutes", batch.timezoneOffsetMinutes)
                .put("observedStartedAt", Instant.ofEpochMilli(batch.observedStartedAtMs).toString())
                .put("observedEndedAt", Instant.ofEpochMilli(batch.observedEndedAtMs).toString())
                .put("stepDelta", batch.stepDelta)
                .put("sensorEventCount", batch.sensorEventCount)
                .put("source", batch.source)
                .put("algorithmVersion", batch.algorithmVersion);
    }

    private void returnReady(StepOutboxBatchEntity batch) {
        requireUpdate(dao.returnInFlightBatchToReady(batch.batchId, batch.ownerId, timeSource.nowMs()));
    }

    private void acknowledge(StepOutboxBatchEntity batch, String code, long accepted, ErtValue earned) {
        requireUpdate(dao.acknowledgeInFlightBatch(
                batch.batchId,
                batch.ownerId,
                safeCode(code, "ACCEPTED"),
                accepted,
                earned.wholeUnitsFloor(),
                earned.exact(),
                earned.display(),
                timeSource.nowMs()
        ));
    }

    private void reject(StepOutboxBatchEntity batch, String code, long accepted, ErtValue earned) {
        requireUpdate(dao.rejectInFlightBatch(
                batch.batchId,
                batch.ownerId,
                safeCode(code, "REJECTED"),
                accepted,
                earned.wholeUnitsFloor(),
                earned.exact(),
                earned.display(),
                timeSource.nowMs()
        ));
    }

    private String safeCode(String value, String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    private void requireUpdate(int count) {
        if (count != 1) {
            throw new IllegalStateException("Outbox state changed during delivery");
        }
    }

    interface TimeSource {
        long nowMs();
    }

    interface StopSignal {
        boolean isStopped();
    }
}
