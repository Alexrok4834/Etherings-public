package xyz.etherings.player.profile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
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

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.MobileSessionApi;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;
import xyz.etherings.player.home.HomeProfileStore;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class ProfileManagementServiceTest {
    private static final String OWNER_ID = "11111111-1111-4111-8111-111111111111";
    private static final String INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";

    private FakeStore store;
    private FakeApi api;
    private HomeProfileStore profileStore;
    private ProfileManagementService service;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("etherings_home_profile_v1", Context.MODE_PRIVATE).edit().clear().commit();
        store = new FakeStore();
        api = new FakeApi();
        profileStore = new HomeProfileStore(context);
        service = new ProfileManagementService(api, new AuthenticatedSession(api, store), profileStore);
    }

    @Test
    public void updatesAndCachesTrimmedDisplayName() {
        ProfileManagementService.Result result = service.updateDisplayName("  New Player  ");

        assertTrue(result.isSuccess());
        assertEquals("New Player", api.displayName);
        assertEquals("New Player", result.profile().displayName());
        assertNotNull(profileStore.snapshot(OWNER_ID));
        assertEquals("New Player", profileStore.snapshot(OWNER_ID).displayName());
    }

    @Test
    public void validatesDisplayNameBeforeNetworkRequest() {
        ProfileManagementService.Result empty = service.updateDisplayName("   ");
        ProfileManagementService.Result longName = service.updateDisplayName("x".repeat(65));

        assertFalse(empty.isSuccess());
        assertFalse(longName.isSuccess());
        assertEquals(0, api.nameCalls);
    }

    @Test
    public void changesPasswordAndClearsOnlySessionCredentials() {
        ProfileManagementService.Result result = service.changePassword(
                "old-password",
                "new-password",
                "new-password"
        );

        assertTrue(result.isSuccess());
        assertTrue(result.isPasswordChanged());
        assertEquals("old-password", api.currentPassword);
        assertEquals("new-password", api.newPassword);
        assertNull(store.credentials);
        assertEquals(1, store.clearCount);
    }

    @Test
    public void rejectsInvalidPasswordFormsWithoutClearingSession() {
        assertFalse(service.changePassword("", "new-password", "new-password").isSuccess());
        assertFalse(service.changePassword("old", "short", "short").isSuccess());
        assertFalse(service.changePassword("old", "new-password", "different").isSuccess());
        assertFalse(service.changePassword("same-password", "same-password", "same-password").isSuccess());

        assertNotNull(store.credentials);
        assertEquals(0, api.passwordCalls);
    }

    @Test
    public void incorrectCurrentPasswordKeepsSessionForRetry() {
        api.passwordError = new ApiException(403, "invalid");

        ProfileManagementService.Result result = service.changePassword(
                "wrong-password",
                "new-password",
                "new-password"
        );

        assertFalse(result.isSuccess());
        assertEquals(ProfileManagementService.ErrorKind.CURRENT_PASSWORD, result.errorKind());
        assertNotNull(store.credentials);
    }

    private static JSONObject profile(String displayName) {
        try {
            return new JSONObject()
                    .put("user", new JSONObject()
                            .put("id", OWNER_ID)
                            .put("username", "test")
                            .put("firstName", displayName)
                            .put("lastName", JSONObject.NULL))
                    .put("balance", new JSONObject().put("ertBalance", 190))
                    .put("todayStats", new JSONObject().put("acceptedSteps", 311));
        } catch (JSONException error) {
            throw new AssertionError(error);
        }
    }

    private static final class FakeApi implements MobileSessionApi, ProfileManagementApi {
        int nameCalls;
        int passwordCalls;
        String displayName;
        String currentPassword;
        String newPassword;
        ApiException passwordError;

        @Override
        public JSONObject updateDisplayName(String displayName, String accessToken) {
            nameCalls += 1;
            this.displayName = displayName;
            return profile(displayName);
        }

        @Override
        public JSONObject changePassword(String currentPassword, String newPassword, String accessToken)
                throws ApiException {
            passwordCalls += 1;
            this.currentPassword = currentPassword;
            this.newPassword = newPassword;
            if (passwordError != null) throw passwordError;
            return new JSONObject();
        }

        @Override
        public JSONObject mobilePasswordLogin(String username, String password, String installationId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JSONObject mobileRefresh(String refreshToken, String installationId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public void mobileLogout(String refreshToken) throws IOException {}
    }

    private static final class FakeStore implements SessionCredentialStore {
        SessionCredentials credentials = new SessionCredentials(
                "access-token",
                "refresh-token-that-is-long-enough-for-tests-1234567890",
                "2027-08-14T00:00:00Z",
                OWNER_ID,
                INSTALLATION_ID
        );
        int clearCount;

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
            clearCount += 1;
        }
    }
}
