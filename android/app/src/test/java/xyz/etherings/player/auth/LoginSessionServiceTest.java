package xyz.etherings.player.auth;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.IOException;

import xyz.etherings.player.api.ApiException;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class LoginSessionServiceTest {
    private static final String OWNER_ID = "11111111-1111-4111-8111-111111111111";
    private static final String INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";

    private FakeApi api;
    private FakeStore store;
    private LoginSessionService service;

    @Before
    public void setUp() {
        api = new FakeApi();
        store = new FakeStore();
        service = new LoginSessionService(
                api,
                store,
                () -> INSTALLATION_ID,
                new AuthenticatedSession(api, store)
        );
    }

    @Test
    public void registersNormalizedAccountAndStoresOnlyReturnedSession() {
        LoginUiState state = service.register(
                "  New_Player  ",
                "secure-password",
                "secure-password",
                "  New Player  "
        );

        assertTrue(state.isAuthenticated());
        assertEquals("new_player", api.registrationUsername);
        assertEquals("secure-password", api.registrationPassword);
        assertEquals("New Player", api.registrationDisplayName);
        assertEquals(INSTALLATION_ID, api.registrationInstallationId);
        assertEquals(OWNER_ID, store.credentials.ownerId());
        assertEquals(INSTALLATION_ID, store.credentials.installationId());
        assertEquals("access-token", store.credentials.accessToken());
        assertFalse(store.credentials.accessToken().contains("secure-password"));
    }

    @Test
    public void rejectsInvalidRegistrationFormsBeforeNetworkOrStorage() {
        assertFalse(service.register("bad!", "secure-password", "secure-password", "Player").isAuthenticated());
        assertFalse(service.register("player", "short", "short", "Player").isAuthenticated());
        assertFalse(service.register("player", "secure-password", "different", "Player").isAuthenticated());
        assertFalse(service.register("player", "secure-password", "secure-password", " ").isAuthenticated());

        assertEquals(0, api.registrationCalls);
        assertNull(store.credentials);
        assertEquals(0, store.saveCalls);
    }

    @Test
    public void mapsRegistrationConflictAndRateLimitWithoutMutatingSession() {
        api.registrationError = new ApiException(409, "{\"code\":\"USERNAME_TAKEN\"}");
        LoginUiState conflict = service.register("player", "secure-password", "secure-password", "Player");
        assertEquals("Username is already taken", conflict.errorMessage());
        assertNull(store.credentials);

        api.registrationError = new ApiException(429, "rate limited");
        LoginUiState rateLimited = service.register("player", "secure-password", "secure-password", "Player");
        assertEquals("Too many attempts. Try again later.", rateLimited.errorMessage());
        assertEquals(0, store.clearCalls);
    }

    @Test
    public void reportsOfflineRegistrationWithoutDiscardingLocalState() {
        api.registrationOffline = true;

        LoginUiState state = service.register("player", "secure-password", "secure-password", "Player");

        assertEquals(LoginUiState.Status.BACKEND_OFFLINE, state.status());
        assertEquals("Backend is unavailable", state.errorMessage());
        assertEquals(0, store.clearCalls);
    }

    @Test
    public void clearsAnIncompleteServerSessionResponse() {
        api.incompleteResponse = true;

        LoginUiState state = service.register("player", "secure-password", "secure-password", "Player");

        assertFalse(state.isAuthenticated());
        assertEquals("Could not save the new session", state.errorMessage());
        assertNull(store.credentials);
        assertEquals(1, store.clearCalls);
    }

    private static JSONObject sessionResponse(boolean incomplete) throws JSONException {
        JSONObject response = new JSONObject()
                .put("user", new JSONObject()
                        .put("id", OWNER_ID)
                        .put("username", "new_player"));
        if (!incomplete) {
            response.put("accessToken", "access-token")
                    .put("refreshToken", "refresh-token-that-is-long-enough-for-tests-1234567890")
                    .put("refreshTokenExpiresAt", "2027-08-14T00:00:00Z");
        }
        return response;
    }

    private static final class FakeApi implements LoginApi, MobileSessionApi {
        int registrationCalls;
        String registrationUsername;
        String registrationPassword;
        String registrationDisplayName;
        String registrationInstallationId;
        ApiException registrationError;
        boolean registrationOffline;
        boolean incompleteResponse;

        @Override
        public JSONObject mobileRegister(String username, String password, String displayName, String installationId)
                throws IOException, JSONException, ApiException {
            registrationCalls += 1;
            registrationUsername = username;
            registrationPassword = password;
            registrationDisplayName = displayName;
            registrationInstallationId = installationId;
            if (registrationOffline) throw new IOException("offline");
            if (registrationError != null) throw registrationError;
            return sessionResponse(incompleteResponse);
        }

        @Override
        public JSONObject mobilePasswordLogin(String username, String password, String installationId)
                throws JSONException {
            return sessionResponse(false);
        }

        @Override
        public JSONObject profile(String accessToken) throws JSONException {
            return sessionResponse(false);
        }

        @Override
        public JSONObject mobileRefresh(String refreshToken, String installationId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void mobileLogout(String refreshToken) {}
    }

    private static final class FakeStore implements SessionCredentialStore {
        SessionCredentials credentials;
        int saveCalls;
        int clearCalls;

        @Override
        public SessionCredentials getCredentials() {
            return credentials;
        }

        @Override
        public void saveCredentials(SessionCredentials credentials) {
            this.credentials = credentials;
            saveCalls += 1;
        }

        @Override
        public void clear() {
            credentials = null;
            clearCalls += 1;
        }
    }
}
