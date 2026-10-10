package xyz.etherings.player.raffle;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.room.Room;
import androidx.test.core.app.ApplicationProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.junit.After;
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
import xyz.etherings.player.sync.EtheringsDatabase;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class RaffleV2DrawCoordinatorTest {
    private static final String OWNER = "11111111-1111-4111-8111-111111111111";
    private static final String CONFIGURATION = "33333333-3333-4333-8333-333333333333";
    private static final String KEY = "44444444-4444-4444-8444-444444444444";

    private EtheringsDatabase database;
    private RafflePendingDrawStore pending;
    private FakeCredentialStore credentials;
    private FakeRaffleApi api;
    private RaffleV2DrawCoordinator coordinator;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        database = Room.inMemoryDatabaseBuilder(context, EtheringsDatabase.class)
                .allowMainThreadQueries().build();
        pending = new RafflePendingDrawStore(database);
        credentials = new FakeCredentialStore();
        api = new FakeRaffleApi();
        coordinator = new RaffleV2DrawCoordinator(api,
                new AuthenticatedSession(new NoRefreshApi(), credentials), credentials, pending,
                () -> KEY, () -> 1000L);
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void persistsSubmittingBeforeNetworkAndCompletesExactCommand() throws Exception {
        api.beforeWrite = body -> {
            RafflePendingDrawEntity row = pending.get(OWNER);
            assertNotNull(row);
            assertEquals(RafflePendingDrawState.SUBMITTING, row.state);
            assertEquals(KEY, row.idempotencyKey);
        };

        RaffleV2DrawCoordinator.Result result = coordinator.submitOrResume(currentDraw());

        assertEquals(RaffleV2DrawCoordinator.Kind.COMPLETED, result.kind());
        assertEquals(KEY, result.idempotencyKey());
        assertEquals("raffle-v2", api.lastBody.getString("contractVersion"));
        assertEquals(CONFIGURATION, api.lastBody.getString("configurationVersion"));
        assertEquals(KEY, api.lastBody.getString("idempotencyKey"));
        assertEquals(RafflePendingDrawState.COMPLETED_UNREVEALED, pending.get(OWNER).state);
        assertEquals(42L, result.evidence().ticket());
        assertEquals(0, result.evidence().selectedSegmentIndex());
        assertEquals("5 ERT", result.evidence().reward().title());
        assertEquals(RaffleV2SelectionEvidence.Fulfillment.Type.ERT_CREDIT,
                result.evidence().fulfillment().type());
    }

    @Test
    public void timeoutRemainsUncertainAndResumeReusesSameKey() throws Exception {
        api.failure = new IOException("timeout");
        RaffleV2DrawCoordinator.Result first = coordinator.submitOrResume(currentDraw());

        assertEquals(RaffleV2DrawCoordinator.Kind.UNCERTAIN, first.kind());
        assertEquals(RafflePendingDrawState.UNCERTAIN, pending.get(OWNER).state);
        assertEquals(KEY, api.lastBody.getString("idempotencyKey"));

        api.failure = null;
        api.replayed = true;
        RaffleV2DrawCoordinator.Result resumed = coordinator.submitOrResume(null);

        assertEquals(RaffleV2DrawCoordinator.Kind.COMPLETED, resumed.kind());
        assertTrue(resumed.replayed());
        assertEquals(KEY, resumed.idempotencyKey());
        assertEquals(2, api.calls);
        assertEquals(KEY, pending.get(OWNER).idempotencyKey);
    }

    @Test
    public void interruptedSubmittingRowIsMadeUncertainBeforeReplay() throws Exception {
        pending.createSubmitting(OWNER, CONFIGURATION, KEY, 900L);
        api.beforeWrite = body -> assertEquals(
                RafflePendingDrawState.UNCERTAIN, pending.get(OWNER).state);

        RaffleV2DrawCoordinator.Result result = coordinator.submitOrResume(null);

        assertEquals(RaffleV2DrawCoordinator.Kind.COMPLETED, result.kind());
        assertEquals(KEY, result.idempotencyKey());
        assertEquals(1, api.calls);
    }

    @Test
    public void stableNoChargeCodeBecomesExplicitlyClearableTerminal() throws Exception {
        api.failure = new ApiException(409,
                "{\"code\":\"RAFFLE_INSUFFICIENT_ERT\",\"message\":\"ignored\"}");

        RaffleV2DrawCoordinator.Result result = coordinator.submitOrResume(currentDraw());

        assertEquals(RaffleV2DrawCoordinator.Kind.TERMINAL_REJECTED, result.kind());
        assertEquals("RAFFLE_INSUFFICIENT_ERT", result.errorCode());
        assertEquals(RafflePendingDrawState.TERMINAL_REJECTED, pending.get(OWNER).state);
        assertNotNull(pending.get(OWNER));
        pending.clearTerminal(OWNER, KEY);
        assertNull(pending.get(OWNER));
    }

    @Test
    public void serverFailureAndMalformedSuccessNeverDiscardOperationKey() throws Exception {
        api.failure = new ApiException(503, "{\"code\":\"RAFFLE_WRITE_UNAVAILABLE\"}");
        assertEquals(RaffleV2DrawCoordinator.Kind.UNCERTAIN,
                coordinator.submitOrResume(currentDraw()).kind());
        assertEquals(KEY, pending.get(OWNER).idempotencyKey);

        api.failure = null;
        api.malformed = true;
        assertEquals(RaffleV2DrawCoordinator.Kind.UNCERTAIN,
                coordinator.submitOrResume(null).kind());
        assertEquals(RafflePendingDrawState.UNCERTAIN, pending.get(OWNER).state);
        assertEquals(KEY, pending.get(OWNER).idempotencyKey);
    }

    @Test
    public void rangeGapOrWrongWinnerCannotBecomeCompleted() throws Exception {
        api.response = success(false);
        api.response.getJSONObject("selection").getJSONArray("ranges")
                .getJSONObject(0).put("startInclusive", "1");

        assertEquals(RaffleV2DrawCoordinator.Kind.UNCERTAIN,
                coordinator.submitOrResume(currentDraw()).kind());
        assertEquals(RafflePendingDrawState.UNCERTAIN, pending.get(OWNER).state);
        assertNull(pending.get(OWNER).responseSnapshot);
    }

    @Test
    public void rewardAndFulfillmentMustMatchWinningRange() throws Exception {
        api.response = success(false);
        api.response.getJSONObject("fulfillment").put("type", "ERU_CREDIT");

        assertEquals(RaffleV2DrawCoordinator.Kind.UNCERTAIN,
                coordinator.submitOrResume(currentDraw()).kind());
        assertNull(pending.get(OWNER).responseSnapshot);
    }

    @Test
    public void replayWithDifferentOperationIdentityCannotReplacePendingSnapshot() throws Exception {
        api.response = success(true);
        api.response.getJSONObject("operation").put("idempotencyKey",
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

        RaffleV2DrawCoordinator.Result result = coordinator.submitOrResume(currentDraw());

        assertEquals(RaffleV2DrawCoordinator.Kind.UNCERTAIN, result.kind());
        assertEquals(KEY, result.idempotencyKey());
        assertEquals(RafflePendingDrawState.UNCERTAIN, pending.get(OWNER).state);
        assertNull(pending.get(OWNER).responseSnapshot);
    }

    @Test
    public void completedSnapshotReturnsLocallyWithoutSecondNetworkWrite() throws Exception {
        RaffleV2DrawCoordinator.Result first = coordinator.submitOrResume(currentDraw());
        assertEquals(RaffleV2DrawCoordinator.Kind.COMPLETED, first.kind());

        RaffleV2DrawCoordinator.Result restored = coordinator.submitOrResume(null);

        assertEquals(RaffleV2DrawCoordinator.Kind.COMPLETED, restored.kind());
        assertEquals(first.responseSnapshot(), restored.responseSnapshot());
        assertEquals(1, api.calls);
    }

    private static RaffleV2Draw currentDraw() throws JSONException {
        JSONObject reward = new JSONObject()
                .put("rewardId", "55555555-5555-4555-8555-555555555555")
                .put("code", "ert-5").put("title", "5 ERT").put("type", "ERT")
                .put("segmentIndex", 0).put("weight", "100")
                .put("probability", new JSONObject().put("numerator", "100").put("denominator", "100"))
                .put("imageUrl", JSONObject.NULL).put("amountExact", "5").put("amountDisplay", "5.00");
        JSONObject draw = new JSONObject()
                .put("drawId", "22222222-2222-4222-8222-222222222222")
                .put("configurationVersion", CONFIGURATION).put("title", "Draw")
                .put("description", JSONObject.NULL)
                .put("cost", new JSONObject().put("currency", "ERT")
                        .put("amountExact", "5").put("amountDisplay", "5.00"))
                .put("attempts", new JSONObject().put("limit", 5).put("used", 0)
                        .put("remaining", 5).put("day", "2026-09-01")
                        .put("resetsAt", "2026-09-02T00:00:00.000Z"))
                .put("totalWeight", "100").put("rewards", new JSONArray().put(reward));
        return RaffleV2Draw.fromJson(new JSONObject().put("contractVersion", "raffle-v2")
                .put("serverTime", "2026-09-01T12:00:00.000Z").put("draw", draw));
    }

    private static JSONObject success(boolean replayed) throws JSONException {
        JSONObject reward = new JSONObject()
                .put("rewardId", "55555555-5555-4555-8555-555555555555")
                .put("code", "ert-5").put("title", "5 ERT").put("type", "ERT")
                .put("segmentIndex", 0).put("weight", "100")
                .put("probability", new JSONObject().put("numerator", "100")
                        .put("denominator", "100"))
                .put("imageUrl", JSONObject.NULL).put("amountExact", "5")
                .put("amountDisplay", "5.00");
        JSONObject range = new JSONObject().put("segmentIndex", 0)
                .put("rewardId", "55555555-5555-4555-8555-555555555555")
                .put("weight", "100").put("startInclusive", "0").put("endExclusive", "100");
        return new JSONObject().put("contractVersion", "raffle-v2")
                .put("operation", new JSONObject()
                        .put("operationId", "66666666-6666-4666-8666-666666666666")
                        .put("idempotencyKey", KEY).put("status", "COMPLETED").put("replayed", replayed))
                .put("draw", new JSONObject()
                        .put("drawResultId", "77777777-7777-4777-8777-777777777777")
                        .put("drawId", "22222222-2222-4222-8222-222222222222")
                        .put("configurationVersion", CONFIGURATION)
                        .put("cost", new JSONObject()).put("attempts", new JSONObject()))
                .put("selection", new JSONObject().put("algorithm", "CSPRNG_UNBIASED_INT_V1")
                        .put("ticket", "42").put("totalWeight", "100")
                        .put("selectedSegmentIndex", 0).put("ranges", new JSONArray().put(range)))
                .put("reward", reward)
                .put("fulfillment", new JSONObject().put("type", "ERT_CREDIT")
                        .put("ledgerTransactionId", "99999999-9999-4999-8999-999999999999")
                        .put("balanceAfterExact", "105").put("balanceAfterDisplay", "105.00"));
    }

    private final class FakeRaffleApi implements RaffleV2Api {
        Exception failure;
        boolean replayed;
        boolean malformed;
        JSONObject response;
        int calls;
        JSONObject lastBody;
        BeforeWrite beforeWrite;

        @Override public JSONObject currentDraw(String token) { throw new AssertionError(); }
        @Override public JSONObject drawHistory(int limit, String cursor, String token) { throw new AssertionError(); }
        @Override public JSONObject executeDraw(JSONObject body, String token)
                throws IOException, JSONException, ApiException {
            calls++;
            lastBody = body;
            if (beforeWrite != null) beforeWrite.run(body);
            if (failure instanceof IOException) throw (IOException) failure;
            if (failure instanceof ApiException) throw (ApiException) failure;
            if (failure instanceof JSONException) throw (JSONException) failure;
            if (malformed) return new JSONObject().put("contractVersion", "raffle-v2");
            return response == null ? success(replayed) : response;
        }
    }

    private interface BeforeWrite { void run(JSONObject body); }

    private static final class FakeCredentialStore implements SessionCredentialStore {
        private SessionCredentials value = new SessionCredentials("access", "refresh",
                "2026-09-02T00:00:00Z", OWNER, "88888888-8888-4888-8888-888888888888");
        @Override public SessionCredentials getCredentials() { return value; }
        @Override public void saveCredentials(SessionCredentials value) { this.value = value; }
        @Override public void clear() { value = null; }
    }

    private static final class NoRefreshApi implements MobileSessionApi {
        @Override public JSONObject mobilePasswordLogin(String username, String password,
                String installationId) {
            throw new AssertionError("login not expected");
        }
        @Override public JSONObject mobileRefresh(String refreshToken, String installationId) {
            throw new AssertionError("refresh not expected");
        }
        @Override public void mobileLogout(String refreshToken) {}
    }
}
