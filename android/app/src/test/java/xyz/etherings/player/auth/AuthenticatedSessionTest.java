package xyz.etherings.player.auth;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

import xyz.etherings.player.api.ApiException;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AuthenticatedSessionTest {
    private FakeStore store;
    private FakeApi api;
    private AuthenticatedSession session;

    @Before
    public void setUp() {
        store = new FakeStore(credentials("access-1", "refresh-1"));
        api = new FakeApi();
        session = new AuthenticatedSession(api, store);
    }

    @Test
    public void successfulRequestDoesNotRefresh() throws Exception {
        String result = session.execute(token -> token);

        assertEquals("access-1", result);
        assertEquals(0, api.refreshCount.get());
    }

    @Test
    public void refreshesOnceOn401AndRetriesWithRotatedAccessToken() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        String result = session.execute(token -> {
            if (calls.getAndIncrement() == 0) {
                throw unauthorized();
            }
            return token;
        });

        assertEquals("access-2", result);
        assertEquals(1, api.refreshCount.get());
        assertEquals("refresh-2", store.credentials.refreshToken());
        assertEquals(1, store.saveCount.get());
    }

    @Test
    public void concurrent401ResponsesRotateOneTimeOnly() throws Exception {
        CountDownLatch bothInitialCalls = new CountDownLatch(2);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        AuthenticatedSession workerSession = new AuthenticatedSession(api, store);
        try {
            AuthenticatedSession.Request<String> request = token -> {
                if ("access-1".equals(token)) {
                    bothInitialCalls.countDown();
                    try {
                        bothInitialCalls.await();
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IOException("Interrupted", error);
                    }
                    throw unauthorized();
                }
                return token;
            };
            Future<String> first = executor.submit(() -> session.execute(request));
            Future<String> second = executor.submit(() -> workerSession.execute(request));

            assertEquals("access-2", first.get());
            assertEquals("access-2", second.get());
            assertEquals(1, api.refreshCount.get());
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void rejectedRefreshClearsCredentials() {
        api.refreshError = unauthorized();

        assertThrows(SessionExpiredException.class, () -> session.execute(token -> {
            throw unauthorized();
        }));
        assertNull(store.credentials);
        assertEquals(1, store.clearCount.get());
    }

    @Test
    public void second401ClearsCredentialsWithoutAnotherRefresh() {
        assertThrows(SessionExpiredException.class, () -> session.execute(token -> {
            throw unauthorized();
        }));

        assertEquals(1, api.refreshCount.get());
        assertNull(store.credentials);
    }

    @Test
    public void transientRefreshFailureKeepsCredentialsForRetry() {
        api.refreshIoError = new IOException("offline");

        assertThrows(IOException.class, () -> session.execute(token -> {
            throw unauthorized();
        }));
        assertNotNull(store.credentials);
        assertEquals("refresh-1", store.credentials.refreshToken());
    }

    @Test
    public void lateRefreshOfOwnerADoesNotReplaceOwnerBSession() {
        SessionCredentials ownerA = store.credentials;
        SessionCredentials ownerB = credentials("access-b", "refresh-b");
        api.onRefresh = () -> store.credentials = ownerB;

        assertThrows(SessionExpiredException.class, () -> session.executeForOwner(
                ownerA.ownerId(), ownerA.installationId(), token -> { throw unauthorized(); }
        ));
        assertEquals("access-b", store.credentials.accessToken());
        assertEquals(ownerB.ownerId(), store.credentials.ownerId());
        assertEquals(0, store.saveCount.get());
    }

    @Test
    public void successfulServerRotationWithLocalWriteFailureClearsOldToken() {
        store.saveError = new GeneralSecurityException("disk failure");

        assertThrows(SessionExpiredException.class, () -> session.execute(token -> {
            throw unauthorized();
        }));
        assertNull(store.credentials);
        assertEquals(1, api.refreshCount.get());
    }

    @Test
    public void logoutAlwaysClearsLocallyEvenWhenRevocationIsOffline() {
        api.logoutIoError = new IOException("offline");

        session.logout();

        assertNull(store.credentials);
        assertEquals(1, api.logoutCount.get());
    }

    @Test
    public void explicitLocalInvalidationDoesNotCallRemoteLogout() {
        session.invalidateLocally();

        assertNull(store.credentials);
        assertEquals(1, store.clearCount.get());
        assertEquals(0, api.logoutCount.get());
    }

    @Test
    public void credentialsValidateOwnerInstallationAndExpiry() {
        assertThrows(IllegalArgumentException.class, () -> new SessionCredentials(
                "a", "r", "not-a-date", UUID.randomUUID().toString(), UUID.randomUUID().toString()
        ));
        assertThrows(IllegalArgumentException.class, () -> new SessionCredentials(
                "a", "r", "2026-09-01T00:00:00Z", "not-owner", UUID.randomUUID().toString()
        ));
    }

    private SessionCredentials credentials(String accessToken, String refreshToken) {
        return new SessionCredentials(
                accessToken,
                refreshToken,
                "2026-09-01T00:00:00Z",
                UUID.randomUUID().toString(),
                UUID.randomUUID().toString()
        );
    }

    private ApiException unauthorized() {
        return new ApiException(401, "{\"code\":\"INVALID_REFRESH_TOKEN\"}");
    }

    private final class FakeApi implements MobileSessionApi {
        final AtomicInteger refreshCount = new AtomicInteger();
        final AtomicInteger logoutCount = new AtomicInteger();
        ApiException refreshError;
        IOException refreshIoError;
        IOException logoutIoError;
        Runnable onRefresh;

        @Override
        public JSONObject mobilePasswordLogin(String username, String password, String installationId) {
            throw new UnsupportedOperationException();
        }

        @Override
        public JSONObject mobileRefresh(String refreshToken, String installationId) throws IOException, ApiException {
            refreshCount.incrementAndGet();
            if (onRefresh != null) onRefresh.run();
            if (refreshIoError != null) throw refreshIoError;
            if (refreshError != null) throw refreshError;
            try {
                return new JSONObject()
                        .put("accessToken", "access-2")
                        .put("refreshToken", "refresh-2")
                        .put("refreshTokenExpiresAt", "2026-10-01T00:00:00Z");
            } catch (JSONException error) {
                throw new AssertionError(error);
            }
        }

        @Override
        public void mobileLogout(String refreshToken) throws IOException {
            logoutCount.incrementAndGet();
            if (logoutIoError != null) throw logoutIoError;
        }
    }

    private static final class FakeStore implements SessionCredentialStore {
        volatile SessionCredentials credentials;
        final AtomicInteger saveCount = new AtomicInteger();
        final AtomicInteger clearCount = new AtomicInteger();
        GeneralSecurityException saveError;

        FakeStore(SessionCredentials credentials) {
            this.credentials = credentials;
        }

        @Override
        public SessionCredentials getCredentials() {
            return credentials;
        }

        @Override
        public void saveCredentials(SessionCredentials credentials) throws GeneralSecurityException {
            if (saveError != null) throw saveError;
            this.credentials = credentials;
            saveCount.incrementAndGet();
        }

        @Override
        public void clear() {
            credentials = null;
            clearCount.incrementAndGet();
        }
    }
}
