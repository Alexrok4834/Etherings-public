package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.Collections;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class CopperRingUiStateTest {
    @Test
    public void exposesLoadingAndFreshInventoryStates() throws Exception {
        CopperRingUiState loading = CopperRingUiState.loadingInventory();
        CopperRingUiState walkLoading = CopperRingUiState.loadingWalk();
        CopperRing ring = ring();
        CopperRingUiState content = CopperRingUiState.fromInventory(
                CopperRingRepository.Result.success(Collections.singletonList(ring))
        );
        CopperRingUiState empty = CopperRingUiState.fromInventory(
                CopperRingRepository.Result.success(Collections.emptyList())
        );

        assertEquals(CopperRingUiState.Status.LOADING, loading.status());
        assertEquals(CopperRingUiState.Screen.INVENTORY, loading.screen());
        assertEquals(CopperRingUiState.Status.LOADING, walkLoading.status());
        assertEquals(CopperRingUiState.Screen.WALK, walkLoading.screen());
        assertEquals(CopperRingUiState.Status.CONTENT, content.status());
        assertEquals(CopperRingUiState.Screen.INVENTORY, content.screen());
        assertEquals(ring.id(), content.firstRing().id());
        assertTrue(content.hasRingContent());
        assertEquals(CopperRingUiState.Status.EMPTY, empty.status());
        assertNull(empty.firstRing());
    }

    @Test
    public void inventoryStateOwnsAnImmutableSnapshot() throws Exception {
        ArrayList<CopperRing> source = new ArrayList<>();
        source.add(ring());
        CopperRingUiState state = CopperRingUiState.fromInventory(CopperRingRepository.Result.success(source));

        source.clear();

        assertEquals(1, state.rings().size());
        assertThrowsUnsupportedMutation(state);
    }

    @Test
    public void staleInventoryIsNeverRepresentedAsFreshEvenWhenEmpty() throws Exception {
        CopperRingUiState withRing = CopperRingUiState.fromInventory(
                CopperRingRepository.Result.stale(Collections.singletonList(ring()), "offline", 1200L)
        );
        CopperRingUiState empty = CopperRingUiState.fromInventory(
                CopperRingRepository.Result.stale(Collections.emptyList(), "offline", 1300L)
        );

        assertEquals(CopperRingUiState.Status.OFFLINE_STALE, withRing.status());
        assertEquals(1200L, withRing.cachedAtMs());
        assertTrue(withRing.isRetryable());
        assertEquals(CopperRingUiState.Status.OFFLINE_STALE, empty.status());
        assertFalse(empty.hasRingContent());
    }

    @Test
    public void mapsDetailContentNotFoundUnavailableAndExpiredSession() throws Exception {
        CopperRingUiState loading = CopperRingUiState.loadingDetail();
        CopperRingUiState content = CopperRingUiState.fromDetail(CopperRingRepository.Result.success(ring()));
        CopperRingUiState stale = CopperRingUiState.fromDetail(
                CopperRingRepository.Result.stale(ring(), "offline", 1400L)
        );
        CopperRingUiState notFound = CopperRingUiState.fromDetail(
                CopperRingRepository.Result.error(CopperRingRepository.ErrorKind.NOT_FOUND, "missing")
        );
        CopperRingUiState unavailable = CopperRingUiState.fromDetail(
                CopperRingRepository.Result.error(CopperRingRepository.ErrorKind.CONFLICT, "conflict")
        );
        CopperRingUiState expired = CopperRingUiState.fromDetail(
                CopperRingRepository.Result.error(CopperRingRepository.ErrorKind.SESSION_EXPIRED, "expired")
        );

        assertEquals(CopperRingUiState.Screen.DETAIL, loading.screen());
        assertEquals(CopperRingUiState.Status.LOADING, loading.status());
        assertEquals(CopperRingUiState.Screen.DETAIL, content.screen());
        assertEquals(CopperRingUiState.Status.CONTENT, content.status());
        assertEquals(CopperRingUiState.Status.OFFLINE_STALE, stale.status());
        assertEquals(1400L, stale.cachedAtMs());
        assertEquals(CopperRingUiState.Status.EMPTY, notFound.status());
        assertEquals(CopperRingUiState.Status.UNAVAILABLE, unavailable.status());
        assertTrue(unavailable.isRetryable());
        assertEquals(CopperRingUiState.Status.SESSION_EXPIRED, expired.status());
        assertFalse(expired.isRetryable());
    }

    @Test
    public void mapsInventoryUnavailableAndExpiredSession() {
        CopperRingUiState unavailable = CopperRingUiState.fromInventory(
                CopperRingRepository.Result.error(CopperRingRepository.ErrorKind.BACKEND_UNAVAILABLE, "offline")
        );
        CopperRingUiState expired = CopperRingUiState.fromInventory(
                CopperRingRepository.Result.error(CopperRingRepository.ErrorKind.UNAUTHENTICATED, "sign in")
        );

        assertEquals(CopperRingUiState.Status.UNAVAILABLE, unavailable.status());
        assertTrue(unavailable.isRetryable());
        assertEquals(CopperRingUiState.Status.SESSION_EXPIRED, expired.status());
    }

    @Test
    public void mapsServerAuthoritativeEquippedRingWithoutInferringInventoryOrder() throws Exception {
        CopperRing ring = ring();
        EquippedCopperRing equipped = EquippedCopperRing.fromJson(new JSONObject()
                .put("ring", ring.toJson())
                .put("equippedAt", "2026-08-19T12:02:00.000Z"));
        CopperRingUiState fresh = CopperRingUiState.fromEquipped(
                CopperRingRepository.Result.success(equipped)
        );
        CopperRingUiState stale = CopperRingUiState.fromEquipped(
                CopperRingRepository.Result.stale(equipped, "offline", 1500L)
        );

        assertEquals(CopperRingUiState.Status.CONTENT, fresh.status());
        assertEquals(CopperRingUiState.Screen.WALK, fresh.screen());
        assertEquals(ring.id(), fresh.firstRing().id());
        assertTrue(fresh.isArtworkOnlyContent());
        assertFalse(fresh.showsRingMetrics());
        assertEquals(CopperRingUiState.Status.OFFLINE_STALE, stale.status());
        assertEquals(1500L, stale.cachedAtMs());
    }

    @Test
    public void exposesMetricsOnlyForRingDetails() throws Exception {
        CopperRingUiState inventory = CopperRingUiState.fromInventory(
                CopperRingRepository.Result.success(Collections.singletonList(ring()))
        );
        CopperRingUiState detail = CopperRingUiState.fromDetail(
                CopperRingRepository.Result.success(ring())
        );

        assertFalse(inventory.isArtworkOnlyContent());
        assertFalse(inventory.showsRingMetrics());
        assertFalse(detail.isArtworkOnlyContent());
        assertTrue(detail.showsRingMetrics());
    }

    private void assertThrowsUnsupportedMutation(CopperRingUiState state) {
        try {
            state.rings().clear();
        } catch (UnsupportedOperationException expected) {
            return;
        }
        throw new AssertionError("ring snapshot must be immutable");
    }

    private CopperRing ring() throws Exception {
        return CopperRing.fromJson(CopperRingTest.ringJson(CopperRingTest.RING_ID, true));
    }
}
