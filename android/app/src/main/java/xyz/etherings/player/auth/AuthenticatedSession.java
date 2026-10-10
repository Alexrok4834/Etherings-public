package xyz.etherings.player.auth;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;

public final class AuthenticatedSession {
    private static final Object REFRESH_LOCK = new Object();

    public interface Request<T> {
        T execute(String accessToken) throws IOException, JSONException, ApiException;
    }

    private final MobileSessionApi api;
    private final SessionCredentialStore credentialStore;

    public AuthenticatedSession(MobileSessionApi api, SessionCredentialStore credentialStore) {
        this.api = api;
        this.credentialStore = credentialStore;
    }

    public <T> T execute(Request<T> request)
            throws IOException, JSONException, ApiException, GeneralSecurityException, SessionExpiredException {
        return executeForOwner(null, null, request);
    }

    public <T> T executeForOwner(String ownerId, String installationId, Request<T> request)
            throws IOException, JSONException, ApiException, GeneralSecurityException, SessionExpiredException {
        SessionCredentials initial = requireCredentialsFor(ownerId, installationId);
        try {
            return request.execute(initial.accessToken());
        } catch (ApiException error) {
            if (error.statusCode() != 401) {
                throw error;
            }
        }

        synchronized (REFRESH_LOCK) {
            SessionCredentials current = requireCredentialsFor(ownerId, installationId);
            if (initial.accessToken().equals(current.accessToken())) {
                current = rotate(current);
            }
            requireCredentialsFor(ownerId, installationId);
            try {
                return request.execute(current.accessToken());
            } catch (ApiException error) {
                if (error.statusCode() == 401) {
                    credentialStore.clearIfCurrent(current);
                    throw new SessionExpiredException("Renewed session was rejected", error);
                }
                throw error;
            }
        }
    }

    public void logout() {
        synchronized (REFRESH_LOCK) {
            String refreshToken = null;
            SessionCredentials current = null;
            try {
                current = credentialStore.getCredentials();
                if (current != null) {
                    refreshToken = current.refreshToken();
                }
                if (refreshToken != null) {
                    api.mobileLogout(refreshToken);
                }
            } catch (IOException | JSONException | ApiException | GeneralSecurityException ignored) {
                // Re-login on this installation revokes an old family if remote logout was offline.
            } finally {
                try {
                    if (current == null) credentialStore.clear();
                    else credentialStore.clearIfCurrent(current);
                } catch (GeneralSecurityException error) {
                    credentialStore.clear();
                }
            }
        }
    }

    public void invalidateLocally() {
        synchronized (REFRESH_LOCK) {
            credentialStore.clear();
        }
    }

    private SessionCredentials rotate(SessionCredentials current)
            throws IOException, JSONException, ApiException, GeneralSecurityException, SessionExpiredException {
        try {
            JSONObject response = api.mobileRefresh(current.refreshToken(), current.installationId());
            SessionCredentials rotated = current.rotate(
                    response.optString("accessToken", ""),
                    response.optString("refreshToken", ""),
                    response.optString("refreshTokenExpiresAt", "")
            );
            try {
                if (!credentialStore.replaceIfCurrent(current, rotated)) {
                    throw new SessionExpiredException("Session changed during refresh");
                }
            } catch (GeneralSecurityException error) {
                try {
                    credentialStore.clearIfCurrent(current);
                } catch (GeneralSecurityException ignored) {
                    credentialStore.clear();
                }
                throw new SessionExpiredException("Rotated credentials could not be stored", error);
            }
            return rotated;
        } catch (ApiException error) {
            if (error.statusCode() == 401 || error.statusCode() == 409) {
                credentialStore.clearIfCurrent(current);
                throw new SessionExpiredException("Refresh credentials were rejected", error);
            }
            throw error;
        } catch (IllegalArgumentException error) {
            credentialStore.clearIfCurrent(current);
            throw new SessionExpiredException("Refresh response was incomplete", error);
        }
    }

    private SessionCredentials requireCredentials() throws SessionExpiredException {
        SessionCredentials credentials;
        try {
            credentials = credentialStore.getCredentials();
        } catch (GeneralSecurityException error) {
            credentialStore.clear();
            throw new SessionExpiredException("Saved credentials could not be read", error);
        }
        if (credentials == null) {
            throw new SessionExpiredException("Sign in is required");
        }
        return credentials;
    }

    private SessionCredentials requireCredentialsFor(String ownerId, String installationId)
            throws SessionExpiredException {
        SessionCredentials credentials = requireCredentials();
        if (ownerId != null && (!ownerId.equals(credentials.ownerId())
                || !installationId.equals(credentials.installationId()))) {
            throw new SessionExpiredException("Session owner or installation changed");
        }
        return credentials;
    }
}
