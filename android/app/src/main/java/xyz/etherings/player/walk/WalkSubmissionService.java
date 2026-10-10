package xyz.etherings.player.walk;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.api.EtheringsApi;
import xyz.etherings.player.auth.SessionStore;
import xyz.etherings.player.step.StepCounterSnapshot;
import xyz.etherings.player.step.StepCounterStore;

public final class WalkSubmissionService {
    private final EtheringsApi api;
    private final SessionStore sessionStore;
    private final StepCounterStore stepCounterStore;
    private final PendingWalkSubmissionStore pendingStore;

    public WalkSubmissionService(
            EtheringsApi api,
            SessionStore sessionStore,
            StepCounterStore stepCounterStore,
            PendingWalkSubmissionStore pendingStore
    ) {
        this.api = api;
        this.sessionStore = sessionStore;
        this.stepCounterStore = stepCounterStore;
        this.pendingStore = pendingStore;
    }

    public WalkSubmissionResult submitCurrentWindow(StepCounterSnapshot snapshot, long nowMs) {
        if (snapshot == null || snapshot.rewardWindowSteps() <= 0L) {
            return WalkSubmissionResult.retryable("No local reward-window steps to submit yet.");
        }

        WalkSubmissionDraft draft = pendingStore.load();
        if (draft == null || WalkSubmissionDraft.STATE_REJECTED.equals(draft.state())) {
            draft = WalkSubmissionDraft.capture(snapshot, nowMs);
        }

        try {
            String accessToken = sessionStore.getAccessToken();
            if (accessToken == null || accessToken.isEmpty()) {
                return WalkSubmissionResult.sessionExpired();
            }

            pendingStore.save(draft);
            if (draft.backendSessionId() == null) {
                JSONObject startedSession = api.startWalkSession(accessToken);
                String backendSessionId = startedSession.optString("id", "");
                if (backendSessionId.trim().isEmpty()) {
                    WalkSubmissionDraft failed = draft.withState(WalkSubmissionDraft.STATE_FAILED_RETRYABLE, "Start response did not include session id");
                    pendingStore.save(failed);
                    return WalkSubmissionResult.retryable("Backend did not return a walk session id. Try again.");
                }
                draft = draft.withBackendSessionId(backendSessionId);
                pendingStore.save(draft);
            }

            JSONObject finishedSession = api.finishWalkSession(draft.backendSessionId(), draft.toFinishPayload(), accessToken);
            String status = finishedSession.optString("status", "");
            if ("ACCEPTED".equals(status)) {
                long acceptedSteps = finishedSession.optLong("acceptedStepCount", 0L);
                long earnedErt = finishedSession.optLong("earnedErt", 0L);
                pendingStore.clear();
                stepCounterStore.resetRewardWindow();
                return WalkSubmissionResult.accepted(acceptedSteps, earnedErt);
            }

            if ("REJECTED".equals(status)) {
                pendingStore.clear();
                return WalkSubmissionResult.rejected(finishedSession.optString("rejectionReason", ""));
            }

            WalkSubmissionDraft failed = draft.withState(WalkSubmissionDraft.STATE_FAILED_RETRYABLE, "Unexpected finish status " + status);
            pendingStore.save(failed);
            return WalkSubmissionResult.retryable("Unexpected backend status: " + (status.isEmpty() ? "empty" : status));
        } catch (ApiException error) {
            if (error.statusCode() == 401) {
                sessionStore.clear();
                return WalkSubmissionResult.sessionExpired();
            }
            saveRetryable(draft, "HTTP " + error.statusCode());
            return WalkSubmissionResult.retryable("Walk submission failed with HTTP " + error.statusCode() + ". Local window was not reset.");
        } catch (IOException error) {
            saveRetryable(draft, "Network unavailable");
            return WalkSubmissionResult.retryable("Backend is unavailable. Local window was not reset.");
        } catch (JSONException error) {
            saveRetryable(draft, "Invalid JSON");
            return WalkSubmissionResult.retryable("Could not parse walk submission response. Local window was not reset.");
        } catch (GeneralSecurityException error) {
            sessionStore.clear();
            return WalkSubmissionResult.sessionExpired();
        }
    }

    private void saveRetryable(WalkSubmissionDraft draft, String summary) {
        try {
            if (draft != null) {
                pendingStore.save(draft.withState(WalkSubmissionDraft.STATE_FAILED_RETRYABLE, summary));
            }
        } catch (JSONException ignored) {
            // If persistence fails, keep the user-facing behavior conservative: do not reset the reward window.
        }
    }
}
