package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
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
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.MobileSessionApi;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RaffleV2ReadRepositoryTest {
    private FakeApi api;
    private FakeStore store;
    private RaffleV2ReadRepository repository;

    @Before
    public void setUp() throws Exception {
        api = new FakeApi();
        api.current = currentResponse();
        api.history = new JSONObject()
                .put("contractVersion", "raffle-v2")
                .put("items", new JSONArray())
                .put("nextCursor", JSONObject.NULL);
        store = new FakeStore();
        repository = new RaffleV2ReadRepository(api, new AuthenticatedSession(api, store));
    }

    @Test
    public void parsesStrictAuthenticatedCurrentDrawWithoutReorderingSegments() {
        RaffleV2ReadRepository.Result<RaffleV2Draw> result = repository.loadCurrent();

        assertTrue(result.isSuccess());
        RaffleV2Draw draw = result.value();
        assertEquals("5.00", draw.cost().display());
        assertEquals(5, draw.attemptLimit());
        assertEquals(4, draw.attemptsRemaining());
        assertEquals(100, draw.totalWeight());
        assertEquals("5 ERT", draw.rewards().get(0).title());
        assertEquals(RaffleV2Reward.Type.COPPER_RING, draw.rewards().get(1).type());
        assertEquals("access-token", api.accessToken);
        try {
            draw.rewards().clear();
            throw new AssertionError("rewards must be immutable");
        } catch (UnsupportedOperationException expected) {
            // Expected immutable API boundary.
        }
    }

    @Test
    public void rejectsProbabilityOrSegmentDriftAsControlledInvalidResponse() throws Exception {
        api.current.getJSONObject("draw").getJSONArray("rewards")
                .getJSONObject(1).getJSONObject("probability").put("denominator", "99");

        RaffleV2ReadRepository.Result<RaffleV2Draw> result = repository.loadCurrent();

        assertFalse(result.isSuccess());
        assertEquals(RaffleV2ReadRepository.ErrorKind.ERROR, result.errorKind());
    }

    @Test
    public void readsOpaqueHistoryPageWithoutParsingCursor() throws Exception {
        api.history.put("items", new JSONArray().put(new JSONObject()
                .put("operationId", "55555555-5555-4555-8555-555555555555")
                .put("draw", new JSONObject())
                .put("selection", new JSONObject())
                .put("reward", new JSONObject())
                .put("fulfillment", new JSONObject())))
                .put("nextCursor", "opaque+/cursor");

        RaffleV2ReadRepository.Result<RaffleV2HistoryPage> result = repository.loadHistory(20, null);

        assertTrue(result.isSuccess());
        assertEquals(1, result.value().itemSnapshots().size());
        assertEquals("opaque+/cursor", result.value().nextCursor());
        assertEquals(20, api.limit);
        assertNull(api.cursor);
    }

    @Test
    public void distinguishesUnavailableOfflineAndMissingSession() {
        api.apiError = new ApiException(404, "{}");
        assertEquals(RaffleV2ReadRepository.ErrorKind.UNAVAILABLE, repository.loadCurrent().errorKind());

        api.apiError = null;
        api.offline = true;
        assertEquals(RaffleV2ReadRepository.ErrorKind.BACKEND_OFFLINE, repository.loadCurrent().errorKind());

        api.offline = false;
        store.credentials = null;
        assertEquals(RaffleV2ReadRepository.ErrorKind.SESSION_EXPIRED, repository.loadCurrent().errorKind());
    }

    private static JSONObject currentResponse() throws JSONException {
        JSONArray rewards = new JSONArray()
                .put(currencyReward("11111111-1111-4111-8111-111111111111", "5 ERT", "ERT", 0, "99", "5", "5.00"))
                .put(new JSONObject()
                        .put("rewardId", "22222222-2222-4222-8222-222222222222")
                        .put("code", "cooper")
                        .put("title", "Cooper Ring")
                        .put("type", "COPPER_RING")
                        .put("segmentIndex", 1)
                        .put("weight", "1")
                        .put("probability", new JSONObject().put("numerator", "1").put("denominator", "100"))
                        .put("imageUrl", JSONObject.NULL)
                        .put("amountExact", JSONObject.NULL)
                        .put("asset", new JSONObject().put("kind", "RING").put("rarity", "COPPER")
                                .put("displayRarity", "Cooper").put("quantity", 1)));
        return new JSONObject()
                .put("contractVersion", "raffle-v2")
                .put("serverTime", "2026-09-01T10:00:00.000Z")
                .put("draw", new JSONObject()
                        .put("drawId", "33333333-3333-4333-8333-333333333333")
                        .put("configurationVersion", "44444444-4444-4444-8444-444444444444")
                        .put("title", "Daily Draw")
                        .put("description", JSONObject.NULL)
                        .put("cost", new JSONObject().put("currency", "ERT")
                                .put("amountExact", "5").put("amountDisplay", "5.00"))
                        .put("attempts", new JSONObject().put("limit", 5).put("used", 1)
                                .put("remaining", 4).put("day", "2026-09-01")
                                .put("resetsAt", "2026-09-02T00:00:00.000Z"))
                        .put("totalWeight", "100")
                        .put("rewards", rewards));
    }

    private static JSONObject currencyReward(String id, String title, String type, int index,
            String weight, String amount, String display) throws JSONException {
        return new JSONObject().put("rewardId", id).put("code", "ert-5").put("title", title)
                .put("type", type).put("segmentIndex", index).put("weight", weight)
                .put("probability", new JSONObject().put("numerator", weight).put("denominator", "100"))
                .put("imageUrl", JSONObject.NULL).put("amountExact", amount).put("amountDisplay", display);
    }

    private static final class FakeApi implements RaffleV2Api, MobileSessionApi {
        JSONObject current;
        JSONObject history;
        String accessToken;
        int limit;
        String cursor;
        boolean offline;
        ApiException apiError;

        @Override
        public JSONObject currentDraw(String accessToken) throws IOException, ApiException {
            this.accessToken = accessToken;
            if (offline) throw new IOException("offline");
            if (apiError != null) throw apiError;
            return current;
        }

        @Override
        public JSONObject drawHistory(int limit, String cursor, String accessToken) throws IOException {
            if (offline) throw new IOException("offline");
            this.limit = limit;
            this.cursor = cursor;
            this.accessToken = accessToken;
            return history;
        }

        @Override public JSONObject executeDraw(JSONObject body, String accessToken) {
            throw new UnsupportedOperationException();
        }

        @Override public JSONObject mobilePasswordLogin(String u, String p, String i) { throw new UnsupportedOperationException(); }
        @Override public JSONObject mobileRefresh(String r, String i) { throw new UnsupportedOperationException(); }
        @Override public void mobileLogout(String r) {}
    }

    private static final class FakeStore implements SessionCredentialStore {
        SessionCredentials credentials = new SessionCredentials("access-token",
                "refresh-token-that-is-long-enough-for-tests-1234567890",
                "2027-09-01T00:00:00Z", "66666666-6666-4666-8666-666666666666",
                "77777777-7777-4777-8777-777777777777");
        @Override public SessionCredentials getCredentials() throws GeneralSecurityException { return credentials; }
        @Override public void saveCredentials(SessionCredentials value) { credentials = value; }
        @Override public void clear() { credentials = null; }
    }
}
