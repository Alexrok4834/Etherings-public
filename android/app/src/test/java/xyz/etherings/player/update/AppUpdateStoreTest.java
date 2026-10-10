package xyz.etherings.player.update;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class AppUpdateStoreTest {
    private Context context;
    private AppUpdateStore store;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("app_update_check", Context.MODE_PRIVATE).edit().clear().commit();
        store = new AppUpdateStore(context);
    }

    @Test
    public void cachesSuccessfulChecksAndSkipsEqualOrOlderVersions() throws Exception {
        AppRelease release = AppRelease.fromJson(AppReleaseTest.validJson(17, false));
        store.recordSuccess(release, 1_000L);

        assertNotNull(store.freshCachedRelease(1_001L));
        assertFalse(store.shouldCheckNetwork(1_001L));
        assertFalse(store.shouldPrompt(release, 17, 1_001L));
        assertFalse(store.shouldPrompt(release, 18, 1_001L));
        assertNull(store.freshCachedRelease(1_000L + UpdateCheckPolicy.SUCCESS_CACHE_MS));
    }

    @Test
    public void backsOffOfflineChecksWithoutBlockingAppUse() {
        store.recordFailure(1_000L);

        assertFalse(store.shouldCheckNetwork(1_001L));
        assertTrue(store.shouldCheckNetwork(
                1_000L + UpdateCheckPolicy.failureBackoffMs(1)));
    }

    @Test
    public void suppressesDismissedOptionalAndRequiredPromptsForBoundedPeriods() throws Exception {
        AppRelease optional = AppRelease.fromJson(AppReleaseTest.validJson(18, false));
        AppRelease required = AppRelease.fromJson(AppReleaseTest.validJson(19, true));

        store.recordDismissed(optional, 1_000L);
        assertFalse(store.shouldPrompt(optional, 17, 1_001L));
        assertTrue(store.shouldPrompt(optional, 17,
                1_000L + UpdateCheckPolicy.OPTIONAL_DISMISS_MS));

        store.recordDismissed(required, 2_000L);
        assertFalse(store.shouldPrompt(required, 17, 2_001L));
        assertTrue(store.shouldPrompt(required, 17,
                2_000L + UpdateCheckPolicy.REQUIRED_DISMISS_MS));
    }
}
