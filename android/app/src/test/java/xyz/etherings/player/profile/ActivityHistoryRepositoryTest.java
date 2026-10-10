package xyz.etherings.player.profile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.IOException;
import java.time.LocalDate;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.MobileSessionApi;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class ActivityHistoryRepositoryTest {
    private static final String OWNER_ID = "11111111-1111-4111-8111-111111111111";
    private static final String INSTALLATION_ID = "22222222-2222-4222-8222-222222222222";

    private FakeApi api;
    private FakeStore store;
    private ActivityHistoryRepository repository;

    @Before
    public void setUp() {
        api = new FakeApi();
        store = new FakeStore();
        repository = new ActivityHistoryRepository(api, new AuthenticatedSession(api, store));
    }

    @Test
    public void loadsAndParsesTheLast30LocalCalendarDays() throws Exception {
        api.response = new JSONObject().put("days", new JSONArray()
                .put(day("2026-08-14", 311, 2, 0))
                .put(day("2026-08-13", 407, 3, 1)));

        ActivityHistoryRepository.Result result = repository.loadLast30Days(LocalDate.of(2026, 8, 14));

        assertTrue(result.isSuccess());
        assertEquals("2026-07-16", api.from);
        assertEquals("2026-08-14", api.to);
        assertEquals("access-token", api.accessToken);
        assertEquals(2, result.items().size());
        assertEquals(LocalDate.of(2026, 8, 14), result.items().get(0).date());
        assertEquals(311, result.items().get(0).acceptedSteps());
        assertEquals("2.00", result.items().get(0).earnedErtDisplay());
        assertEquals(5000, result.items().get(0).stepCap().intValue());
        assertEquals(1, result.items().get(1).raffleAttempts());
    }

    @Test
    public void preservesAnEmptyHistoryAsASuccessfulEmptyState() throws Exception {
        api.response = new JSONObject().put("days", new JSONArray());

        ActivityHistoryRepository.Result result = repository.loadLast30Days(LocalDate.of(2026, 8, 14));

        assertTrue(result.isSuccess());
        assertTrue(result.items().isEmpty());
    }

    @Test
    public void reportsOfflineWithoutInventingZeroRows() {
        api.offline = true;

        ActivityHistoryRepository.Result result = repository.loadLast30Days(LocalDate.of(2026, 8, 14));

        assertFalse(result.isSuccess());
        assertEquals(ActivityHistoryRepository.ErrorKind.BACKEND_OFFLINE, result.errorKind());
    }

    @Test
    public void rejectsMalformedRowsAsAControlledParseError() throws Exception {
        api.response = new JSONObject().put("days", new JSONArray().put(new JSONObject().put("date", "bad")));

        ActivityHistoryRepository.Result result = repository.loadLast30Days(LocalDate.of(2026, 8, 14));

        assertFalse(result.isSuccess());
        assertEquals(ActivityHistoryRepository.ErrorKind.ERROR, result.errorKind());
    }

    @Test
    public void reportsAnAbsentSessionWithoutCallingTheApi() {
        store.credentials = null;

        ActivityHistoryRepository.Result result = repository.loadLast30Days(LocalDate.of(2026, 8, 14));

        assertFalse(result.isSuccess());
        assertEquals(ActivityHistoryRepository.ErrorKind.SESSION_EXPIRED, result.errorKind());
        assertEquals(0, api.calls);
    }

    private static JSONObject day(String date, long steps, long ert, long raffles) throws JSONException {
        return new JSONObject()
                .put("date", date)
                .put("acceptedSteps", steps)
                .put("earnedErt", ert)
                .put("earnedErtExact", Long.toString(ert))
                .put("earnedErtDisplay", ert + ".00")
                .put("stepCap", 5000)
                .put("raffleAttempts", raffles);
    }

    private static final class FakeApi implements ActivityHistoryApi, MobileSessionApi {
        JSONObject response = new JSONObject();
        String from;
        String to;
        String accessToken;
        int calls;
        boolean offline;

        @Override
        public JSONObject activityHistory(String from, String to, String accessToken) throws IOException {
            calls += 1;
            this.from = from;
            this.to = to;
            this.accessToken = accessToken;
            if (offline) throw new IOException("offline");
            return response;
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
        public void mobileLogout(String refreshToken) throws ApiException {}
    }

    private static final class FakeStore implements SessionCredentialStore {
        SessionCredentials credentials = new SessionCredentials(
                "access-token",
                "refresh-token-that-is-long-enough-for-tests-1234567890",
                "2027-08-14T00:00:00Z",
                OWNER_ID,
                INSTALLATION_ID
        );

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
}
