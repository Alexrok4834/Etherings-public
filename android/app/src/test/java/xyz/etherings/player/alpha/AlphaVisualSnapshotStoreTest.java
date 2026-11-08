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
}
