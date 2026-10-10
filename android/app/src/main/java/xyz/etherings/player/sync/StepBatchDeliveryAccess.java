package xyz.etherings.player.sync;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.SessionExpiredException;

/** Authorization boundary for the existing owner-scoped Room outbox. */
public interface StepBatchDeliveryAccess {
    Identity current() throws GeneralSecurityException;

    JSONObject submitForOwner(String ownerId, String installationId, StepBatchApi api, JSONObject payload)
            throws IOException, JSONException, ApiException, GeneralSecurityException, SessionExpiredException;

    void invalidateOnSecurityError(Identity identity);

    final class Identity {
        private final String ownerId;
        private final String installationId;
        private final Object credentialHandle;

        public Identity(String ownerId, String installationId) {
            this(ownerId, installationId, null);
        }

        Identity(String ownerId, String installationId, Object credentialHandle) {
            if (ownerId == null || installationId == null) throw new IllegalArgumentException("Identity is required");
            this.ownerId = ownerId;
            this.installationId = installationId;
            this.credentialHandle = credentialHandle;
        }

        public String ownerId() { return ownerId; }
        public String installationId() { return installationId; }
        Object credentialHandle() { return credentialHandle; }
    }
}
