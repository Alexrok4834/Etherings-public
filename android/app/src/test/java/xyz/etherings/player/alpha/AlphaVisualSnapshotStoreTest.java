package xyz.etherings.player.alpha;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AlphaVisualSnapshotStoreTest {
    @Test public void survivesNewStoreButNeverAnotherAccountOrSession() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        AlphaVisualSnapshotStore store = new AlphaVisualSnapshotStore(context);
        store.clear();
        store.save("owner", "session", "home", new JSONObject().put("value", 1), store.revision());
        assertEquals(1, new AlphaVisualSnapshotStore(context).load("owner", "session", "home").getInt("value"));
        assertNull(store.load("other", "session", "home"));
        assertNull(store.load("owner", "session", "home"));
        store.save("owner", "session", "home", new JSONObject(), store.revision());
        assertNull(store.load("owner", "new-session", "home"));
    }
    @Test public void invalidationRejectsAnOlderReadCompletingLater() throws Exception {
        AlphaVisualSnapshotStore store = new AlphaVisualSnapshotStore(ApplicationProvider.getApplicationContext());
        store.clear();
        long beforeMutation = store.revision();
        store.clear();
        store.save("owner", "session", "rings", new JSONObject(), beforeMutation);
        assertNull(store.load("owner", "session", "rings"));
        store.save("owner", "session", "rings", new JSONObject(), store.revision());
        assertNotNull(store.load("owner", "session", "rings"));
    }

    @Test public void oversizedOrExpiredPreviewIsNotDisplayed() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        AlphaVisualSnapshotStore store = new AlphaVisualSnapshotStore(context);
        store.clear();
        store.save("owner", "session", "home", new JSONObject().put("data", "x".repeat(262144)), store.revision());
        assertNull(store.load("owner", "session", "home"));
        java.io.File file = new java.io.File(context.getNoBackupFilesDir(), "alpha-visual-v1.json");
        JSONObject root = new JSONObject().put("owner", "owner").put("lineage", "session")
                .put("home", new JSONObject().put("at", System.currentTimeMillis() - 86400001L)
                        .put("data", new JSONObject()));
        java.nio.file.Files.write(file.toPath(), root.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        assertNull(store.load("owner", "session", "home"));
    }

    private JSONObject inventory(boolean listed) throws Exception {
        return new JSONObject().put("assets", new org.json.JSONArray())
                .put("listingStatusAvailable", listed).put("listedMints", new org.json.JSONArray());
    }

    @Test public void ringsCanPreviewHomeButHomeCannotInventStarter() throws Exception {
        AlphaVisualSnapshotStore store = new AlphaVisualSnapshotStore(ApplicationProvider.getApplicationContext());
        store.clear();
        store.save("owner", "line", "rings", new JSONObject().put("equipment", "ring")
                .put("silver", inventory(true)), store.revision());
        assertEquals("ring", store.load("owner", "line", "home").getString("equipment"));
        store.clear();
        store.save("owner", "line", "home", new JSONObject().put("silver", inventory(false)), store.revision());
        assertNull(store.load("owner", "line", "rings"));
    }

    @Test public void newerInventoryIsSharedWithoutReplacingScreenOrWalletBalances() throws Exception {
        AlphaVisualSnapshotStore store = new AlphaVisualSnapshotStore(ApplicationProvider.getApplicationContext());
        store.clear();
        store.save("owner", "line", "rings", new JSONObject().put("starter", "kept")
                .put("silver", inventory(true)), store.revision());
        store.save("owner", "line", "wallet", new JSONObject().put("sol", "7")
                .put("address", "bound").put("silver", inventory(false)), store.revision());
        JSONObject rings = store.load("owner", "line", "rings");
        assertEquals("kept", rings.getString("starter"));
        assertTrue(rings.getJSONObject("silver").getBoolean("listingStatusAvailable"));
        assertFalse(rings.has("sol"));
        rings.getJSONObject("silver").put("mutated", true);
        assertFalse(store.load("owner", "line", "home").getJSONObject("silver").has("mutated"));
        assertEquals("7", store.load("owner", "line", "wallet").getString("sol"));
    }

    @Test public void walletWithoutListingDataKeepsRingsBadgesUntilFreshUnlistedResult() throws Exception {
        AlphaVisualSnapshotStore store = new AlphaVisualSnapshotStore(ApplicationProvider.getApplicationContext());
        store.clear();
        String mint = "2sPQFVoJt3PjLSW6z8AMq4pDn1K1ba8u12iGL3GYk2yq";
        JSONObject listed = inventory(true).put("listedMints", new org.json.JSONArray().put(mint));
        store.save("owner", "line", "rings", new JSONObject().put("silver", listed), store.revision());
        store.save("owner", "line", "wallet", new JSONObject().put("silver", inventory(false)), store.revision());
        assertEquals(mint, store.load("owner", "line", "rings").getJSONObject("silver")
                .getJSONArray("listedMints").getString(0));
        assertFalse(store.load("owner", "line", "home").getJSONObject("silver")
                .getBoolean("listingStatusAvailable"));
        // A fresh, explicitly empty listing result must remove the old badge.
        store.save("owner", "line", "rings", new JSONObject().put("silver", inventory(true)), store.revision());
        assertEquals(0, store.load("owner", "line", "rings").getJSONObject("silver")
                .getJSONArray("listedMints").length());
        store.clear();
        store.save("owner", "line", "wallet", new JSONObject().put("silver", inventory(false)), store.revision());
        assertNull(store.load("owner", "line", "rings"));
    }

    @Test public void slowerOlderReadCannotReplaceNewerScreenOrSharedInventory() throws Exception {
        AlphaVisualSnapshotStore store = new AlphaVisualSnapshotStore(ApplicationProvider.getApplicationContext());
        store.clear();
        long revision = store.revision(), old = store.beginRead(), recent = store.beginRead();
        store.save("owner", "line", "rings", new JSONObject().put("value", "new")
                .put("silver", inventory(false)), revision, recent);
        store.save("owner", "line", "rings", new JSONObject().put("value", "old")
                .put("silver", inventory(true)), revision, old);
        store.save("owner", "line", "home", new JSONObject().put("silver", inventory(true)), revision, old);
        assertEquals("new", store.load("owner", "line", "rings").getString("value"));
        assertFalse(store.load("owner", "line", "home").getJSONObject("silver").getBoolean("listingStatusAvailable"));
        store.clear();
        store.save("owner", "line", "wallet", new JSONObject().put("silver", inventory(true)), revision, recent);
        assertNull(store.load("owner", "line", "home"));
    }

    @Test public void malformedSharedDataAndOtherAccountCannotReplaceGoodPreview() throws Exception {
        AlphaVisualSnapshotStore store = new AlphaVisualSnapshotStore(ApplicationProvider.getApplicationContext());
        store.clear();
        store.save("owner", "line", "rings", new JSONObject().put("silver", inventory(true)), store.revision());
        store.save("owner", "line", "wallet", new JSONObject().put("silver", new JSONObject()), store.revision());
        assertTrue(store.load("owner", "line", "rings").getJSONObject("silver").getBoolean("listingStatusAvailable"));
        assertNull(store.load("other", "line", "home"));
        assertNull(store.load("owner", "line", "home"));
    }
}
