package xyz.etherings.player.home;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.IOException;
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.MobileSessionApi;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class HomeRepositoryTest {
    private static final String OWNER_ID = "11111111-1111-4111-8111-111111111111";
    private static final String INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";

    private HomeProfileStore profileStore;
    private FakeCredentialStore credentialStore;
    private FakeApi api;
    private HomeRepository repository;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("etherings_home_profile_v1", Context.MODE_PRIVATE)
                .edit()
                .clear()
                .commit();
        profileStore = new HomeProfileStore(context);
        credentialStore = new FakeCredentialStore(credentials());
        api = new FakeApi(profile(190L));
        repository = new HomeRepository(
                api,
                new AuthenticatedSession(api, credentialStore),
                credentialStore,
                profileStore
        );
    }

    @Test
    public void returnsOwnerScopedCachedProfileWhileOffline() {
        HomeRepository.Result online = repository.loadHomeProfile();
        assertTrue(online.isSuccess());
        assertFalse(online.isStale());

        api.offline = true;
        HomeRepository.Result offline = repository.loadHomeProfile();

        assertTrue(offline.isSuccess());
        assertTrue(offline.isStale());
        assertTrue(offline.serverValuesKnown());
        assertEquals(OWNER_ID, offline.profile().userId());
        assertEquals(190L, offline.profile().ertBalance());
    }

    @Test
    public void preservesOwnerForLocalStateWhenOfflineBeforeFirstProfileCache() {
        api.offline = true;

        HomeRepository.Result result = repository.loadHomeProfile();

        assertTrue(result.isSuccess());
        assertTrue(result.isStale());
        assertFalse(result.serverValuesKnown());
        assertEquals(OWNER_ID, result.profile().userId());
        assertEquals(0L, result.profile().ertBalance());
    }

    @Test
    public void requiresSignInOnlyWhenCredentialsAreActuallyAbsent() {
        credentialStore.credentials = null;

        HomeRepository.Result result = repository.loadHomeProfile();

        assertFalse(result.isSuccess());
        assertEquals(HomeRepository.ErrorKind.UNAUTHENTICATED, result.errorKind());
    }

    @Test
    public void rejectsProfileForDifferentOwner() throws Exception {
        api.profile = profile(10L).put("user", new JSONObject().put("id", INSTALLATION_ID));

        HomeRepository.Result result = repository.loadHomeProfile();

        assertFalse(result.isSuccess());
        assertEquals(HomeRepository.ErrorKind.ERROR, result.errorKind());
    }

    @Test
    public void cachedProfilesRemainOwnerScoped() throws Exception {
        profileStore.save(HomeProfile.fromJson(profile(190L)));

        assertNotNull(profileStore.snapshot(OWNER_ID));
        assertEquals(null, profileStore.snapshot(INSTALLATION_ID));
    }

    @Test
    public void debugParseFailureNamesOnlyTheRejectedWhitelistedField() throws Exception {
        api.profile = profile(10L);
        api.profile.getJSONObject("balance")
                .put("eruBalanceExact", "1.25")
                .put("eruBalanceDisplay", "1.24");

        HomeRepository.Result result = repository.loadHomeProfile();

        assertFalse(result.isSuccess());
        assertEquals(HomeRepository.ErrorKind.ERROR, result.errorKind());
        assertEquals("Could not parse profile response [field: eruBalanceDisplay]", result.errorMessage());
        assertFalse(result.errorMessage().contains("1.25"));
        assertFalse(result.errorMessage().contains("1.24"));
    }

    private static SessionCredentials credentials() {
        return new SessionCredentials(
                "access-token",
                "refresh-token-that-is-long-enough-for-tests-1234567890",
                "2027-08-14T00:00:00Z",
                OWNER_ID,
                INSTALLATION_ID
        );
    }

    private static JSONObject profile(long ertBalance) {
        try {
            return new JSONObject()
                    .put("user", new JSONObject()
                            .put("id", OWNER_ID)
                            .put("username", "test")
                            .put("firstName", "Test")
                            .put("lastName", JSONObject.NULL))
                    .put("balance", new JSONObject().put("ertBalance", ertBalance))
                    .put("todayStats", new JSONObject().put("acceptedSteps", 311));
        } catch (JSONException error) {
            throw new AssertionError(error);
        }
    }

    private static final class FakeCredentialStore implements SessionCredentialStore {
        SessionCredentials credentials;

        FakeCredentialStore(SessionCredentials credentials) {
            this.credentials = credentials;
        }

        @Override
        public SessionCredentials getCredentials() {
            return credentials;
        }

        @Override
        public void saveCredentials(SessionCredentials credentials) {
            this.credentials = credentials;
        }

        @Override
        public void clear() {
            credentials = null;
        }
    }

    private static final class FakeApi implements MobileSessionApi, HomeProfileApi {
        JSONObject profile;
        boolean offline;

        FakeApi(JSONObject profile) {
            this.profile = profile;
        }

        @Override
        public JSONObject profile(String accessToken) throws IOException {
            if (offline) {
                throw new IOException("offline");
            }
            return profile;
        }

        @Override
        public JSONObject mobilePasswordLogin(String username, String password, String installationId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JSONObject mobileRefresh(String refreshToken, String installationId) throws ApiException {
            throw new ApiException(401, "rejected");
        }

        @Override
        public void mobileLogout(String refreshToken) {}
    }
}
