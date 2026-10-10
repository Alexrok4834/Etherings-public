package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
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
import java.security.GeneralSecurityException;

import xyz.etherings.player.api.ApiException;
import xyz.etherings.player.auth.AuthenticatedSession;
import xyz.etherings.player.auth.MobileSessionApi;
import xyz.etherings.player.auth.SessionCredentialStore;
import xyz.etherings.player.auth.SessionCredentials;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class CopperRingRepositoryTest {
    private static final String OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String INSTALLATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    private CopperRingCache cache;
    private FakeCredentialStore credentials;
    private FakeApi api;
    private CopperRingRepository repository;

    @Before
    public void setUp() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences(CopperRingCache.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();
        cache = new CopperRingCache(context, () -> 4000L);
        credentials = new FakeCredentialStore(session(OWNER_A));
        api = new FakeApi();
        repository = new CopperRingRepository(
                api,
                new AuthenticatedSession(api, credentials),
                credentials,
                cache
        );
    }

    @Test
    public void loadsAndCachesInventoryDetailAndEquippedDataForTheSessionOwner() {
        CopperRingRepository.Result<java.util.List<CopperRing>> inventory = repository.loadInventory();
        CopperRingRepository.Result<CopperRing> detail = repository.loadDetail(CopperRingTest.RING_ID);
        CopperRingRepository.Result<EquippedCopperRing> equipped = repository.loadEquipped();

        assertTrue(inventory.isSuccess());
        assertFalse(inventory.isStale());
        assertEquals(1, inventory.value().size());
        assertEquals(CopperRingTest.RING_ID, detail.value().id());
        assertEquals(CopperRingTest.RING_ID, equipped.value().ring().id());
        assertEquals(OWNER_A, api.lastOwnerExpectation);
        assertEquals(4000L, cache.inventory(OWNER_A).cachedAtMs());
    }

    @Test
    public void returnsStaleCacheOfflineOnlyForTheSameOwner() {
        assertTrue(repository.loadInventory().isSuccess());
        api.offline = true;

        CopperRingRepository.Result<java.util.List<CopperRing>> ownerAOffline = repository.loadInventory();
        assertTrue(ownerAOffline.isSuccess());
        assertTrue(ownerAOffline.isStale());
        assertEquals(4000L, ownerAOffline.cachedAtMs());

        credentials.value = session(OWNER_B);
        CopperRingRepository.Result<java.util.List<CopperRing>> ownerBOffline = repository.loadInventory();
        assertFalse(ownerBOffline.isSuccess());
        assertEquals(CopperRingRepository.ErrorKind.BACKEND_UNAVAILABLE, ownerBOffline.errorKind());
        assertNull(ownerBOffline.value());
    }

    @Test
    public void mapsStableBackendCodesWithoutServingConflictOrNotFoundCache() {
        assertTrue(repository.loadDetail(CopperRingTest.RING_ID).isSuccess());

        api.apiError = new ApiException(404, "{\"code\":\"RING_NOT_FOUND\"}");
        assertEquals(CopperRingRepository.ErrorKind.NOT_FOUND, repository.loadDetail(CopperRingTest.RING_ID).errorKind());

        api.apiError = new ApiException(409, "{\"code\":\"RING_STATE_CONFLICT\"}");
        assertEquals(CopperRingRepository.ErrorKind.CONFLICT, repository.loadDetail(CopperRingTest.RING_ID).errorKind());

        api.apiError = new ApiException(503, "{\"code\":\"RING_READ_UNAVAILABLE\"}");
        CopperRingRepository.Result<CopperRing> unavailable = repository.loadDetail(CopperRingTest.RING_ID);
        assertTrue(unavailable.isSuccess());
        assertTrue(unavailable.isStale());
    }

    @Test
    public void reportsAndClearsAnExpiredSessionInsteadOfShowingCachedData() {
        assertTrue(repository.loadInventory().isSuccess());
        api.apiError = new ApiException(401, "{\"message\":\"Invalid access token\"}");

        CopperRingRepository.Result<java.util.List<CopperRing>> result = repository.loadInventory();

        assertFalse(result.isSuccess());
        assertEquals(CopperRingRepository.ErrorKind.SESSION_EXPIRED, result.errorKind());
        assertNull(credentials.value);
    }

    @Test
    public void distinguishesMissingCredentialsFromUnreadableSecureStorage() {
        credentials.value = null;
        assertEquals(CopperRingRepository.ErrorKind.UNAUTHENTICATED, repository.loadInventory().errorKind());

        credentials.readError = new GeneralSecurityException("corrupt storage");
        assertEquals(CopperRingRepository.ErrorKind.ERROR, repository.loadInventory().errorKind());
    }

    @Test
    public void previewsLevelUpAndCommitsSeparateProgressionMutations() throws Exception {
        CopperRing ring = repository.loadDetail(CopperRingTest.RING_ID).value();
        CopperAttributeAllocation allocation = new CopperAttributeAllocation(5, 3, 0, 0);

        CopperRingRepository.Result<CopperLevelPreview> preview = repository.previewLevelUp(ring);
        CopperRingRepository.Result<CopperLevelUpResult> result = repository.levelUp(
                ring, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        );
        CopperRingRepository.Result<CopperAttributeAllocationResult> allocationResult =
                repository.allocateAttributePoints(
                        ring, allocation, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

        assertTrue(preview.isSuccess());
        assertEquals("12.00", preview.value().ertCostDisplay());
        assertTrue(result.isSuccess());
        assertEquals(2, result.value().level());
        assertTrue(allocationResult.isSuccess());
        assertEquals(0, allocationResult.value().unspentAttributePoints());
        assertEquals("dddddddd-dddd-4ddd-8ddd-dddddddddddd", api.lastLevelUpKey);
        assertEquals("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", api.lastAllocationKey);
        assertFalse(api.lastLevelUpBody.has("allocation"));
        assertEquals(8, api.lastAllocationBody.getInt("expectedUnspentPoints"));
        assertEquals(5, api.lastAllocationBody.getJSONObject("allocation").getInt("comfort"));
        assertEquals(3, api.lastAllocationBody.getJSONObject("allocation").getInt("charm"));

        CopperRingRepository.Result<EquippedCopperRing> equipment = repository.equip(
                ring,
                "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                "ffffffff-ffff-4fff-8fff-ffffffffffff"
        );
        assertTrue(equipment.isSuccess());
        assertEquals(CopperRingTest.RING_ID, equipment.value().ring().id());
        assertEquals("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                api.lastEquipmentBody.getString("expectedEquippedRingId"));
        assertEquals("ring-equipment-v1", api.lastEquipmentBody.getString("contractVersion"));
    }

    @Test
    public void mapsAllocationStaleInsufficientConflictAndTransportFailures() {
        CopperRing ring = repository.loadDetail(CopperRingTest.RING_ID).value();
        CopperAttributeAllocation allocation = new CopperAttributeAllocation(1, 0, 0, 0);

        api.apiError = new ApiException(409, "{\"code\":\"RING_ATTRIBUTE_POINTS_STALE\"}");
        assertEquals(CopperRingRepository.ErrorKind.STALE_POINTS,
                repository.allocateAttributePoints(ring, allocation, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").errorKind());
        api.apiError = new ApiException(409, "{\"code\":\"RING_ATTRIBUTE_POINTS_INSUFFICIENT\"}");
        assertEquals(CopperRingRepository.ErrorKind.INSUFFICIENT_POINTS,
                repository.allocateAttributePoints(ring, allocation, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").errorKind());
        api.apiError = new ApiException(409, "{\"code\":\"RING_ATTRIBUTE_ALLOCATION_IDEMPOTENCY_CONFLICT\"}");
        assertEquals(CopperRingRepository.ErrorKind.IDEMPOTENCY_CONFLICT,
                repository.allocateAttributePoints(ring, allocation, "cccccccc-cccc-4ccc-8ccc-cccccccccccc").errorKind());
        api.apiError = null;
        api.offline = true;
        assertEquals(CopperRingRepository.ErrorKind.BACKEND_UNAVAILABLE,
                repository.allocateAttributePoints(ring, allocation, "dddddddd-dddd-4ddd-8ddd-dddddddddddd").errorKind());
    }

    @Test
    public void requiresSessionAndMapsEquipmentConflicts() {
        CopperRing ring = repository.loadDetail(CopperRingTest.RING_ID).value();

        api.apiError = new ApiException(409, "{\"code\":\"RING_EQUIPMENT_STALE\"}");
        assertEquals(CopperRingRepository.ErrorKind.CONFLICT,
                repository.equip(ring, CopperRingTest.RING_ID,
                        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").errorKind());

        api.apiError = new ApiException(409,
                "{\"code\":\"RING_EQUIPMENT_IDEMPOTENCY_CONFLICT\"}");
        assertEquals(CopperRingRepository.ErrorKind.IDEMPOTENCY_CONFLICT,
                repository.equip(ring, CopperRingTest.RING_ID,
                        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").errorKind());

        api.apiError = null;
        api.lastEquipmentBody = null;
        credentials.value = null;
        assertEquals(CopperRingRepository.ErrorKind.UNAUTHENTICATED,
                repository.equip(ring, CopperRingTest.RING_ID,
                        "cccccccc-cccc-4ccc-8ccc-cccccccccccc").errorKind());
        assertNull(api.lastEquipmentBody);
    }

    private static SessionCredentials session(String ownerId) {
        return new SessionCredentials(
                "access-token",
                "refresh-token-that-is-long-enough-for-tests-1234567890",
                "2027-08-19T00:00:00Z",
                ownerId,
                INSTALLATION_ID
        );
    }

    private static final class FakeCredentialStore implements SessionCredentialStore {
        SessionCredentials value;
        GeneralSecurityException readError;

        FakeCredentialStore(SessionCredentials value) { this.value = value; }

        @Override
        public SessionCredentials getCredentials() throws GeneralSecurityException {
            if (readError != null) throw readError;
            return value;
        }

        @Override
        public void saveCredentials(SessionCredentials credentials) { value = credentials; }

        @Override
        public void clear() { value = null; }
    }

    private static final class FakeApi implements CopperRingApi, MobileSessionApi {
        boolean offline;
        ApiException apiError;
        String lastOwnerExpectation;
        String lastLevelUpKey;
        String lastAllocationKey;
        JSONObject lastLevelUpBody;
        JSONObject lastAllocationBody;
        JSONObject lastEquipmentBody;

        @Override
        public JSONObject rings(String accessToken) throws IOException, JSONException, ApiException {
            failIfNeeded();
            lastOwnerExpectation = OWNER_A;
            return new JSONObject().put("rings", new org.json.JSONArray().put(CopperRingTest.ringJson(CopperRingTest.RING_ID, true)));
        }

        @Override
        public JSONObject ring(String ringId, String accessToken) throws IOException, JSONException, ApiException {
            failIfNeeded();
            return CopperRingTest.ringJson(ringId, true);
        }

        @Override
        public JSONObject equippedRing(String accessToken) throws IOException, JSONException, ApiException {
            failIfNeeded();
            return new JSONObject()
                    .put("ring", CopperRingTest.ringJson(CopperRingTest.RING_ID, true))
                    .put("equippedAt", "2026-08-19T12:02:00.000Z");
        }

        @Override
        public JSONObject previewLevelUp(String ringId, JSONObject body, String accessToken) throws IOException, JSONException, ApiException {
            failIfNeeded();
            return new JSONObject().put("target", new JSONObject().put("level", 2).put("unspentAttributePoints", 12))
                    .put("grantedAttributePoints", 4)
                    .put("cost", new JSONObject().put("ert", 12)
                            .put("eru", 0).put("eruExact", "0").put("eruDisplay", "0"))
                    .put("balances", new JSONObject().put("eru", 0)
                            .put("eruExact", "0").put("eruDisplay", "0"))
                    .put("available", true).put("blockers", new org.json.JSONArray());
        }

        @Override
        public JSONObject levelUp(String ringId, JSONObject body, String accessToken) throws IOException, JSONException, ApiException {
            failIfNeeded();
            lastLevelUpBody = body;
            lastLevelUpKey = body.getString("idempotencyKey");
            return new JSONObject().put("operationId", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee")
                    .put("level", new JSONObject().put("current", 2))
                    .put("unspentAttributePoints", new JSONObject().put("granted", 4).put("current", 12))
                    .put("cost", new JSONObject().put("eru", 0)
                            .put("eruExact", "0").put("eruDisplay", "0"))
                    .put("balances", new JSONObject().put("ertAfter", 88)
                            .put("eruAfter", 0).put("eruAfterExact", "0").put("eruAfterDisplay", "0"));
        }

        @Override
        public JSONObject allocateAttributePoints(String ringId, JSONObject body, String accessToken)
                throws IOException, JSONException, ApiException {
            failIfNeeded();
            lastAllocationBody = body;
            lastAllocationKey = body.getString("idempotencyKey");
            return new JSONObject().put("operationId", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
                    .put("attributes", new JSONObject().put("current", new JSONObject()
                            .put("comfort", 4).put("charm", 20).put("quality", 7).put("luck", 11)))
                    .put("unspentAttributePoints", new JSONObject().put("current", 0));
        }

        @Override
        public JSONObject equipRing(String ringId, JSONObject body, String accessToken)
                throws IOException, JSONException, ApiException {
            failIfNeeded();
            lastEquipmentBody = body;
            return new JSONObject()
                    .put("ring", CopperRingTest.ringJson(ringId, true))
                    .put("equippedAt", "2026-08-20T12:02:00.000Z");
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

        private void failIfNeeded() throws IOException, ApiException {
            if (offline) throw new IOException("offline");
            if (apiError != null) throw apiError;
        }
    }
}
