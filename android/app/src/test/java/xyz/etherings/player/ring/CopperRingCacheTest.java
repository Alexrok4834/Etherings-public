package xyz.etherings.player.ring;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.Collections;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class CopperRingCacheTest {
    private static final String OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    private static final String OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    private static final String RING_B = "22222222-2222-4222-8222-222222222222";

    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences(CopperRingCache.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test
    public void neverReturnsAnotherOwnersInventoryAndClearsOldPayloadsOnSwitch() throws Exception {
        MutableClock clock = new MutableClock(1000L);
        CopperRingCache cache = new CopperRingCache(context, clock);
        CopperRing ringA = CopperRing.fromJson(CopperRingTest.ringJson(CopperRingTest.RING_ID, true));
        cache.saveInventory(OWNER_A, Collections.singletonList(ringA));

        assertEquals(1000L, cache.inventory(OWNER_A).cachedAtMs());
        assertNull(cache.inventory(OWNER_B));

        clock.now = 2000L;
        CopperRing ringB = CopperRing.fromJson(CopperRingTest.ringJson(RING_B, true));
        cache.saveInventory(OWNER_B, Collections.singletonList(ringB));

        assertNull(cache.inventory(OWNER_A));
        assertEquals(RING_B, cache.inventory(OWNER_B).value().get(0).id());
        assertEquals(2000L, cache.inventory(OWNER_B).cachedAtMs());
    }

    @Test
    public void scopesDetailAndEquippedSnapshotsByOwnerAndRing() throws Exception {
        CopperRingCache cache = new CopperRingCache(context, () -> 3000L);
        CopperRing ring = CopperRing.fromJson(CopperRingTest.ringJson(CopperRingTest.RING_ID, true));
        EquippedCopperRing equipped = EquippedCopperRing.fromJson(new JSONObject()
                .put("ring", ring.toJson())
                .put("equippedAt", "2026-08-19T12:02:00.000Z"));
        cache.saveDetail(OWNER_A, ring);
        cache.saveEquipped(OWNER_A, equipped);

        assertNotNull(cache.detail(OWNER_A, ring.id()));
        assertNull(cache.detail(OWNER_A, RING_B));
        assertNull(cache.detail(OWNER_B, ring.id()));
        assertEquals(ring.id(), cache.equipped(OWNER_A).value().ring().id());

        cache.clearForOwner(OWNER_B);
        assertNotNull(cache.equipped(OWNER_A));
        cache.clearForOwner(OWNER_A);
        assertNull(cache.equipped(OWNER_A));
    }

    @Test
    public void persistsAllOwnerSnapshotsAcrossCacheRecreation() throws Exception {
        CopperRing ring = CopperRing.fromJson(CopperRingTest.ringJson(CopperRingTest.RING_ID, true));
        EquippedCopperRing equipped = EquippedCopperRing.fromJson(new JSONObject()
                .put("ring", ring.toJson())
                .put("equippedAt", "2026-08-20T12:02:00.000Z"));
        CopperRingCache first = new CopperRingCache(context, () -> 4000L);
        first.saveInventory(OWNER_A, Collections.singletonList(ring));
        first.saveDetail(OWNER_A, ring);
        first.saveEquipped(OWNER_A, equipped);

        CopperRingCache reopened = new CopperRingCache(context, () -> 5000L);

        assertEquals(ring.id(), reopened.inventory(OWNER_A).value().get(0).id());
        assertEquals(ring.id(), reopened.detail(OWNER_A, ring.id()).value().id());
        assertEquals(ring.id(), reopened.equipped(OWNER_A).value().ring().id());
        assertNull(reopened.inventory(OWNER_B));
        assertNull(reopened.detail(OWNER_B, ring.id()));
        assertNull(reopened.equipped(OWNER_B));
    }

    @Test
    public void accountSwitchClearsEverySnapshotOwnedByThePreviousAccount() throws Exception {
        CopperRing ringA = CopperRing.fromJson(CopperRingTest.ringJson(CopperRingTest.RING_ID, true));
        EquippedCopperRing equippedA = EquippedCopperRing.fromJson(new JSONObject()
                .put("ring", ringA.toJson())
                .put("equippedAt", "2026-08-20T12:02:00.000Z"));
        CopperRingCache cache = new CopperRingCache(context, () -> 6000L);
        cache.saveInventory(OWNER_A, Collections.singletonList(ringA));
        cache.saveDetail(OWNER_A, ringA);
        cache.saveEquipped(OWNER_A, equippedA);

        CopperRing ringB = CopperRing.fromJson(CopperRingTest.ringJson(RING_B, true));
        cache.saveInventory(OWNER_B, Collections.singletonList(ringB));

        assertNull(cache.inventory(OWNER_A));
        assertNull(cache.detail(OWNER_A, ringA.id()));
        assertNull(cache.equipped(OWNER_A));
        assertEquals(ringB.id(), cache.inventory(OWNER_B).value().get(0).id());
        assertNull(cache.detail(OWNER_B, ringA.id()));
        assertNull(cache.equipped(OWNER_B));
    }

    private static final class MutableClock implements CopperRingCache.Clock {
        long now;

        MutableClock(long now) { this.now = now; }

        @Override
        public long nowMs() { return now; }
    }
}
