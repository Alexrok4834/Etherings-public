package xyz.etherings.player.sync;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.UUID;

import xyz.etherings.player.economy.ErtValue;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class SyncStatusStoreTest {
    private static final String PREFS_NAME = "etherings_sync_status_v1";

    private Context context;
    private SharedPreferences preferences;
    private SyncStatusStore store;
    private String ownerId;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        preferences.edit().clear().commit();
        store = new SyncStatusStore(context);
        ownerId = UUID.randomUUID().toString();
    }

    @Test
    public void exactValueSurvivesCacheUpdatesAndRemainsOwnerScoped() {
        store.save(ownerId, snapshot(ErtValue.fromExact("1.005")));
        store.markAttempt(ownerId, true, 900L);

        SyncStatusSnapshot restored = store.snapshot(ownerId);
        assertEquals("1.005", restored.syncedErtExact());
        assertEquals("1.01", restored.syncedErtDisplay());
        assertEquals(900L, restored.lastAttemptAtMs());
        assertEquals("0", store.snapshot(UUID.randomUUID().toString()).syncedErtExact());
        assertFalse(preferences.contains("synced_ert"));
    }

    @Test
    public void legacyIntegerIsReadOnceAndMalformedExactPairFailsClosed() {
        preferences.edit()
                .putString("owner_id", ownerId)
                .putLong("synced_ert", 7L)
                .commit();

        assertEquals("7", store.snapshot(ownerId).syncedErtExact());
        assertEquals("7.00", store.snapshot(ownerId).syncedErtDisplay());

        preferences.edit()
                .remove("synced_ert_exact")
                .putString("synced_ert_display", "7.00")
                .commit();
        assertEquals("0", store.snapshot(ownerId).syncedErtExact());
        assertEquals("0.00", store.snapshot(ownerId).syncedErtDisplay());
    }

    private SyncStatusSnapshot snapshot(ErtValue syncedErt) {
        return new SyncStatusSnapshot(0L, 0, 100L, syncedErt, 1, 0L, 0, 800L, 0L, false);
    }
}
