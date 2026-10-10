package xyz.etherings.player.sync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.room.Room;
import androidx.test.core.app.ApplicationProvider;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.MobileSessionApi;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class StepBatchDeliveryEngineTest {
    private EtheringsDatabase database;
    private StepSyncDao dao;
    private FakeTransport transport;
    private FakeCredentialStore credentialStore;
    private StepBatchDeliveryEngine engine;
    private String ownerId;
    private String installationId;
    private long nowMs;

    @Before
    public void setUp() {
        Context context = ApplicationProvider.getApplicationContext();
        database = Room.inMemoryDatabaseBuilder(context, EtheringsDatabase.class)
                .allowMainThreadQueries()
                .build();
        dao = database.stepSyncDao();
        ownerId = UUID.randomUUID().toString();
        installationId = UUID.randomUUID().toString();
        nowMs = 1_786_428_000_000L;
        dao.insertInstallation(new SyncInstallationEntity(1, installationId, 0L, nowMs));
        credentialStore = new FakeCredentialStore(new SessionCredentials(
                "access-1",
                "refresh-1-refresh-1-refresh-1-refresh-1-refresh-1",
                "2026-09-01T00:00:00Z",
                ownerId,
                installationId
        ));
        transport = new FakeTransport();
        engine = new StepBatchDeliveryEngine(
                dao,
                transport,
                new AuthenticatedSession(transport, credentialStore),
                credentialStore,
                () -> nowMs,
                () -> false
        );
    }

    @After
    public void tearDown() {
        database.close();
    }

    @Test
    public void acceptedResponseAcknowledgesClaimedBatch() {
        StepOutboxBatchEntity batch = insertReady(0L);
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());

        StepOutboxBatchEntity saved = dao.getBatch(batch.batchId);
        assertEquals(SyncBatchState.ACKED, saved.state);
        assertEquals(1, saved.attemptCount);
        assertEquals(100L, saved.acceptedStepDelta.longValue());
        assertEquals(1L, saved.earnedErtDelta.longValue());
        assertEquals("1", saved.earnedErtDeltaExact);
        assertEquals("1.00", saved.earnedErtDeltaDisplay);
        assertEquals(1, transport.payloads.size());
        assertEquals(batch.batchId, transport.payloads.get(0).optString("batchId"));
    }

    @Test
    public void exactFractionalReceiptIsStoredWithoutBinaryOrIntegerLoss() throws Exception {
        StepOutboxBatchEntity batch = insertReady(0L);
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 0L)
                .put("earnedErtDeltaExact", "0.13065")
                .put("earnedErtDeltaDisplay", "0.13"));

        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());

        StepOutboxBatchEntity saved = dao.getBatch(batch.batchId);
        assertEquals(SyncBatchState.ACKED, saved.state);
        assertEquals(0L, saved.earnedErtDelta.longValue());
        assertEquals("0.13065", saved.earnedErtDeltaExact);
        assertEquals("0.13", saved.earnedErtDeltaDisplay);
    }

    @Test
    public void mismatchedExactDisplayReturnsBatchToReady() throws Exception {
        StepOutboxBatchEntity batch = insertReady(0L);
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 0L)
                .put("earnedErtDeltaExact", "0.13065")
                .put("earnedErtDeltaDisplay", "0.14"));

        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());

        StepOutboxBatchEntity saved = dao.getBatch(batch.batchId);
        assertEquals(SyncBatchState.READY, saved.state);
        assertNull(saved.earnedErtDelta);
        assertNull(saved.earnedErtDeltaExact);
        assertNull(saved.earnedErtDeltaDisplay);
    }

    @Test
    public void exactReceiptOutsideLegacySqliteRangeReturnsBatchToReady() throws Exception {
        StepOutboxBatchEntity batch = insertReady(0L);
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 0L)
                .put("earnedErtDeltaExact", "9223372036854775808")
                .put("earnedErtDeltaDisplay", "9223372036854775808.00"));

        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());
        assertEquals(SyncBatchState.READY, dao.getBatch(batch.batchId).state);
    }

    @Test
    public void terminalRejectionDoesNotBlockNextBatch() {
        StepOutboxBatchEntity first = insertReady(0L);
        StepOutboxBatchEntity second = insertReady(1L);
        transport.responses.add(response(first, "REJECTED", "EXPIRED_BATCH", 0L, 0L));
        transport.responses.add(response(second, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals(SyncBatchState.TERMINAL_REJECTED, dao.getBatch(first.batchId).state);
        assertEquals(SyncBatchState.ACKED, dao.getBatch(second.batchId).state);
    }

    @Test
    public void networkFailureReturnsClaimToReadyForBackoff() {
        StepOutboxBatchEntity batch = insertReady(0L);
        transport.ioError = new IOException("offline");

        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());
        assertEquals(SyncBatchState.READY, dao.getBatch(batch.batchId).state);
        assertEquals(1, dao.getBatch(batch.batchId).attemptCount);
    }

    @Test
    public void permanentHttpErrorIsArchivedAndQueueContinues() {
        StepOutboxBatchEntity first = insertReady(0L);
        StepOutboxBatchEntity second = insertReady(1L);
        transport.apiErrors.add(new ApiException(409, "conflict"));
        transport.responses.add(response(second, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals("HTTP_409", dao.getBatch(first.batchId).resultCode);
        assertEquals(SyncBatchState.ACKED, dao.getBatch(second.batchId).state);
    }

    @Test
    public void drainsAtMostTenBatchesPerRun() {
        for (long sequence = 0L; sequence < 11L; sequence++) {
            StepOutboxBatchEntity batch = insertReady(sequence);
            transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L));
        }

        assertEquals(StepBatchDeliveryEngine.Outcome.MORE_PENDING, engine.drain());
        assertEquals(1, dao.readyBatchCount(ownerId));
        assertEquals(10, dao.listBatches(ownerId, SyncBatchState.ACKED, 20).size());
    }

    @Test
    public void missingCredentialsDoesNotClaimAnotherOwnersQueue() {
        StepOutboxBatchEntity batch = insertReady(0L);
        credentialStore.credentials = null;

        assertEquals(StepBatchDeliveryEngine.Outcome.AUTH_REQUIRED, engine.drain());
        assertEquals(SyncBatchState.READY, dao.getBatch(batch.batchId).state);
        assertNull(dao.getBatch(batch.batchId).lastAttemptAtMs);
    }

    @Test
    public void stoppedDrainDoesNotClaimReadyBatch() {
        StepOutboxBatchEntity batch = insertReady(0L);
        StepBatchDeliveryEngine stopped = new StepBatchDeliveryEngine(
                dao,
                transport,
                new AuthenticatedSession(transport, credentialStore),
                credentialStore,
                () -> nowMs,
                () -> true
        );

        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, stopped.drain());
        assertEquals(SyncBatchState.READY, dao.getBatch(batch.batchId).state);
        assertEquals(0, dao.getBatch(batch.batchId).attemptCount);
    }

    @Test
    public void staleInFlightBatchIsRecoveredAfterProcessDeath() {
        StepOutboxBatchEntity batch = insertReady(0L);
        dao.markReadyBatchInFlight(batch.batchId, ownerId, nowMs - 16L * 60L * 1000L);
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals(SyncBatchState.ACKED, dao.getBatch(batch.batchId).state);
        assertEquals(2, dao.getBatch(batch.batchId).attemptCount);
    }

    @Test
    public void accountSwitchBetweenClaimAndSendNeverUsesNewOwnersCredentials() {
        StepOutboxBatchEntity batch = insertReady(0L);
        String otherOwner = UUID.randomUUID().toString();
        SessionCredentials original = credentialStore.credentials;
        credentialStore.onRead = () -> {
            if (credentialStore.readCount == 2) {
                credentialStore.credentials = credentials(otherOwner, "access-b");
            }
        };
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.AUTH_REQUIRED, engine.drain());
        assertEquals(SyncBatchState.READY, dao.getBatch(batch.batchId).state);
        assertEquals(otherOwner, credentialStore.credentials.ownerId());
        assertEquals(0, transport.payloads.size());
        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals(SyncBatchState.READY, dao.getBatch(batch.batchId).state);
        credentialStore.credentials = original;
        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals(SyncBatchState.ACKED, dao.getBatch(batch.batchId).state);
        assertEquals("access-1", transport.accessTokens.get(0));
    }

    @Test
    public void accountSwitchAfter401NeverRetriesOldBatchWithNewOwnersToken() {
        StepOutboxBatchEntity batch = insertReady(0L);
        String otherOwner = UUID.randomUUID().toString();
        transport.apiErrors.add(new ApiException(401, "expired"));
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L));
        transport.onSubmit = () -> {
            if (transport.payloads.size() == 1) {
                credentialStore.credentials = credentials(otherOwner, "access-b");
            }
        };

        assertEquals(StepBatchDeliveryEngine.Outcome.AUTH_REQUIRED, engine.drain());
        assertEquals(SyncBatchState.READY, dao.getBatch(batch.batchId).state);
        assertEquals(otherOwner, credentialStore.credentials.ownerId());
        assertEquals(1, transport.payloads.size());
        assertEquals("access-1", transport.accessTokens.get(0));
    }

    @Test
    public void logoutDuringDrainReturnsClaimWithoutTerminalLoss() {
        StepOutboxBatchEntity batch = insertReady(0L);
        transport.apiErrors.add(new ApiException(401, "expired"));
        transport.onSubmit = credentialStore::clear;

        assertEquals(StepBatchDeliveryEngine.Outcome.AUTH_REQUIRED, engine.drain());
        assertEquals(SyncBatchState.READY, dao.getBatch(batch.batchId).state);
        assertNull(credentialStore.credentials);
    }

    @Test
    public void crashAfterSendBeforeReceiptRetriesSameBatchAfterLease() {
        StepOutboxBatchEntity batch = insertReady(0L);
        dao.markReadyBatchInFlight(batch.batchId, ownerId, nowMs);
        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());
        assertEquals(0, transport.payloads.size());

        nowMs += 16L * 60L * 1000L;
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L));
        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals(batch.batchId, transport.payloads.get(0).optString("batchId"));
        assertEquals(SyncBatchState.ACKED, dao.getBatch(batch.batchId).state);
    }

    @Test
    public void crashAfterServerCommitBeforeLocalAckReplaysIdentityAfterLease() {
        StepOutboxBatchEntity batch = insertReady(0L);
        dao.markReadyBatchInFlight(batch.batchId, ownerId, nowMs);
        nowMs += 16L * 60L * 1000L;
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals(batch.batchId, transport.payloads.get(0).optString("batchId"));
        assertEquals(SyncBatchState.ACKED, dao.getBatch(batch.batchId).state);
        assertEquals(2, dao.getBatch(batch.batchId).attemptCount);
    }

    @Test
    public void unresolvedEarlierInFlightBlocksLaterReadyUntilLeaseRecovery() {
        StepOutboxBatchEntity first = insertReady(0L);
        StepOutboxBatchEntity second = insertReady(1L);
        dao.markReadyBatchInFlight(first.batchId, ownerId, nowMs);
        transport.responses.add(response(first, "ACCEPTED", "ACCEPTED", 100L, 1L));
        transport.responses.add(response(second, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());
        assertEquals(SyncBatchState.IN_FLIGHT, dao.getBatch(first.batchId).state);
        assertEquals(SyncBatchState.READY, dao.getBatch(second.batchId).state);
        assertEquals(0, transport.payloads.size());

        nowMs += 16L * 60L * 1000L;
        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals(first.batchId, transport.payloads.get(0).optString("batchId"));
        assertEquals(second.batchId, transport.payloads.get(1).optString("batchId"));
        assertEquals(SyncBatchState.ACKED, dao.getBatch(first.batchId).state);
        assertEquals(SyncBatchState.ACKED, dao.getBatch(second.batchId).state);
    }

    @Test
    public void unresolvedOwnerADoesNotBlockIndependentOwnerBStream() {
        StepOutboxBatchEntity a = insertReady(0L);
        dao.markReadyBatchInFlight(a.batchId, ownerId, nowMs);
        String otherOwner = UUID.randomUUID().toString();
        StepOutboxBatchEntity b = insertReady(otherOwner, 1L);
        credentialStore.credentials = credentials(otherOwner, "access-b");
        transport.responses.add(response(b, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());
        assertEquals(SyncBatchState.IN_FLIGHT, dao.getBatch(a.batchId).state);
        assertEquals(SyncBatchState.ACKED, dao.getBatch(b.batchId).state);
        assertEquals("access-b", transport.accessTokens.get(0));
    }

    private SessionCredentials credentials(String owner, String access) {
        return new SessionCredentials(
                access, "refresh-2-refresh-2-refresh-2-refresh-2-refresh-2",
                "2026-09-01T00:00:00Z", owner, installationId
        );
    }

    @Test
    public void malformedResponseReturnsBatchToReadyWithoutAccountingClaim() {
        StepOutboxBatchEntity batch = insertReady(0L);
        transport.responses.add(new JSONObject());

        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());
        StepOutboxBatchEntity saved = dao.getBatch(batch.batchId);
        assertEquals(SyncBatchState.READY, saved.state);
        assertNull(saved.acceptedStepDelta);
        assertNull(saved.earnedErtDelta);
    }

    @Test
    public void transientHttpErrorsRetryUntilTheStableTerminalResponseArrives() {
        StepOutboxBatchEntity batch = insertReady(0L);
        transport.apiErrors.add(new ApiException(500, "server unavailable"));
        transport.apiErrors.add(new ApiException(429, "rate limited"));
        transport.responses.add(response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L));

        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());
        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());
        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());

        StepOutboxBatchEntity saved = dao.getBatch(batch.batchId);
        assertEquals(SyncBatchState.ACKED, saved.state);
        assertEquals(3, saved.attemptCount);
        assertEquals(3, transport.payloads.size());
        assertEquals(1L, saved.earnedErtDelta.longValue());
    }

    @Test
    public void timeoutAfterRemoteCommitRetriesTheSameIdentityAndAppliesOneReceipt() {
        StepOutboxBatchEntity batch = insertReady(0L);
        JSONObject stableReceipt = response(batch, "ACCEPTED", "ACCEPTED", 100L, 1L);
        transport.responses.add(stableReceipt);
        transport.ioError = new IOException("response lost after server commit");

        assertEquals(StepBatchDeliveryEngine.Outcome.RETRY, engine.drain());
        transport.ioError = null;
        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());

        StepOutboxBatchEntity saved = dao.getBatch(batch.batchId);
        assertEquals(SyncBatchState.ACKED, saved.state);
        assertEquals(2, saved.attemptCount);
        assertEquals(2, transport.payloads.size());
        assertEquals(
                transport.payloads.get(0).optString("batchId"),
                transport.payloads.get(1).optString("batchId")
        );
        assertEquals(1L, saved.earnedErtDelta.longValue());
    }

    @Test
    public void concurrentDrainsSerializeAndDeliverEachBatchOnce() throws Exception {
        StepOutboxBatchEntity first = insertReady(0L);
        StepOutboxBatchEntity second = insertReady(1L);
        transport.responses.add(response(first, "ACCEPTED", "ACCEPTED", 100L, 1L));
        transport.responses.add(response(second, "ACCEPTED", "ACCEPTED", 100L, 1L));
        StepBatchDeliveryEngine otherEngine = new StepBatchDeliveryEngine(
                dao,
                transport,
                new AuthenticatedSession(transport, credentialStore),
                credentialStore,
                () -> nowMs,
                () -> false
        );
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<StepBatchDeliveryEngine.Outcome> firstDrain = executor.submit(engine::drain);
            Future<StepBatchDeliveryEngine.Outcome> secondDrain = executor.submit(otherEngine::drain);

            StepBatchDeliveryEngine.Outcome firstOutcome = firstDrain.get();
            StepBatchDeliveryEngine.Outcome secondOutcome = secondDrain.get();
            assertTrue(firstOutcome == StepBatchDeliveryEngine.Outcome.COMPLETE
                    || firstOutcome == StepBatchDeliveryEngine.Outcome.RETRY);
            assertTrue(secondOutcome == StepBatchDeliveryEngine.Outcome.COMPLETE
                    || secondOutcome == StepBatchDeliveryEngine.Outcome.RETRY);
        } finally {
            executor.shutdownNow();
        }

        assertEquals(StepBatchDeliveryEngine.Outcome.COMPLETE, engine.drain());

        assertEquals(SyncBatchState.ACKED, dao.getBatch(first.batchId).state);
        assertEquals(SyncBatchState.ACKED, dao.getBatch(second.batchId).state);
        assertEquals(2, transport.payloads.size());
        assertEquals(first.batchId, transport.payloads.get(0).optString("batchId"));
        assertEquals(second.batchId, transport.payloads.get(1).optString("batchId"));
        assertEquals(1, dao.getBatch(first.batchId).attemptCount);
        assertEquals(1, dao.getBatch(second.batchId).attemptCount);
    }

    private StepOutboxBatchEntity insertReady(long sequence) {
        return insertReady(ownerId, sequence);
    }

    private StepOutboxBatchEntity insertReady(String owner, long sequence) {
        StepOutboxBatchEntity batch = new StepOutboxBatchEntity(
                UUID.randomUUID().toString(),
                owner,
                installationId,
                sequence,
                "2026-08-12",
                180,
                nowMs - 120_000L + sequence * 1_000L,
                nowMs - 60_000L + sequence * 1_000L,
                100L,
                2L,
                "android_step_counter",
                "room-step-counter-v1",
                SyncBatchState.READY,
                0,
                null,
                null,
                null,
                null,
                nowMs,
                nowMs
        );
        dao.insertBatch(batch);
        return batch;
    }

    private JSONObject response(
            StepOutboxBatchEntity batch,
            String status,
            String code,
            long accepted,
            long earned
    ) {
        try {
            return new JSONObject()
                    .put("batchId", batch.batchId)
                    .put("installationId", batch.installationId)
                    .put("sequence", batch.sequence)
                    .put("status", status)
                    .put("resultCode", code)
                    .put("acceptedStepDelta", accepted)
                    .put("earnedErtDelta", earned);
        } catch (JSONException error) {
            throw new AssertionError(error);
        }
    }

    private static final class FakeCredentialStore implements SessionCredentialStore {
        SessionCredentials credentials;
        int readCount;
        Runnable onRead;

        FakeCredentialStore(SessionCredentials credentials) {
            this.credentials = credentials;
        }

        @Override
        public SessionCredentials getCredentials() {
            readCount++;
            if (onRead != null) onRead.run();
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

    private static final class FakeTransport implements StepBatchApi, MobileSessionApi {
        final List<JSONObject> responses = new ArrayList<>();
        final List<ApiException> apiErrors = new ArrayList<>();
        final List<JSONObject> payloads = new ArrayList<>();
        final List<String> accessTokens = new ArrayList<>();
        IOException ioError;
        Runnable onSubmit;

        @Override
        public JSONObject submitStepBatch(JSONObject body, String accessToken) throws IOException, ApiException {
            payloads.add(body);
            accessTokens.add(accessToken);
            if (onSubmit != null) onSubmit.run();
            if (ioError != null) throw ioError;
            if (!apiErrors.isEmpty()) throw apiErrors.remove(0);
            return responses.remove(0);
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
        public void mobileLogout(String refreshToken) {
        }
    }
}
