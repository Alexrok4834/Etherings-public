package xyz.etherings.player.alpha;

import android.content.Context;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.function.Supplier;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.SessionExpiredException;
import xyz.etherings.player.sync.StepBatchApi;
import xyz.etherings.player.sync.StepBatchDeliveryAccess;

/** Alpha access-only authorization for the retained owner-scoped step outbox. */
public final class AlphaStepBatchAccess implements StepBatchDeliveryAccess {
    private final Supplier<AlphaSessionStore.VerifiedSession> sessions;
    private final String installationId;
    private final AlphaSessionStore store;
    private final AlphaAuthApi renewalApi;

    public AlphaStepBatchAccess(AlphaSessionStore store, String installationId) {
        this(store::verified, installationId, store, null);
    }

    public AlphaStepBatchAccess(AlphaSessionStore store, String installationId,
                                Context context, String baseUrl) {
        this(store::verified, installationId, store, new AlphaAuthApi(context, baseUrl));
    }

    AlphaStepBatchAccess(Supplier<AlphaSessionStore.VerifiedSession> sessions, String installationId) {
        this(sessions, installationId, null, null);
    }

    private AlphaStepBatchAccess(Supplier<AlphaSessionStore.VerifiedSession> sessions,
                                 String installationId, AlphaSessionStore store, AlphaAuthApi renewalApi) {
        this.sessions = sessions;
        this.installationId = installationId;
        this.store = store;
        this.renewalApi = renewalApi;
    }

    @Override public Identity current() {
        AlphaSessionStore.VerifiedSession session = sessions.get();
        return session == null ? null : new Identity(session.ownerId(), installationId);
    }

    @Override public JSONObject submitForOwner(String ownerId, String batchInstallationId,
            StepBatchApi api, JSONObject payload) throws IOException, JSONException,
            ApiException, GeneralSecurityException, SessionExpiredException {
        AlphaSessionStore.VerifiedSession session = sessions.get();
        if (session == null || !ownerId.equals(session.ownerId())
                || !installationId.equals(batchInstallationId)) {
            throw new SessionExpiredException("Alpha session owner or installation changed");
        }
        AlphaSessionIdentity initial = store == null ? null : store.current();
        String accessToken = initial != null && session.ownerId().equals(initial.accountId)
                && session.lineage().equals(initial.lineage) ? initial.token : session.token();
        try {
            return api.submitStepBatch(payload, accessToken);
        } catch (ApiException error) {
            if (error.statusCode() == 401) {
                if (renewalApi != null) {
                    try {
                        String renewed = renewalApi.renewAfterUnauthorized(accessToken, initial);
                        if (renewed != null) {
                            try { return api.submitStepBatch(payload, renewed); }
                            catch (ApiException retry) {
                                if (retry.statusCode() != 401) throw retry;
                                AlphaSessionIdentity current = store.current();
                                if (current != null && current.token.equals(renewed))
                                    store.clearIfCurrent(current);
                            }
                        }
                    } catch (IOException unavailable) { throw unavailable; }
                    catch (Exception unavailable) { throw new IOException("Alpha renewal unavailable", unavailable); }
                }
                throw new SessionExpiredException("Alpha session was rejected", error);
            }
            if (error.statusCode() == 404) {
                // The guarded DEV step-sync route is intentionally absent while earning is off.
                throw new IOException("Alpha step-sync route is unavailable", error);
            }
            throw error;
        }
    }

    @Override public void invalidateOnSecurityError(Identity identity) {
        // The encrypted Alpha store invalidates unreadable sessions itself; never clear a new login.
    }
}
