package xyz.etherings.player.update;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;
import androidx.work.Configuration;
import androidx.work.testing.SynchronousExecutor;
import androidx.work.testing.WorkManagerTestInitHelper;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;

import xyz.etherings.player.MainActivity;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28, qualifiers = "w320dp-h640dp")
public final class AppUpdatePromptTest {
    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("app_update_check", Context.MODE_PRIVATE).edit().clear().commit();
        Configuration configuration = new Configuration.Builder()
                .setExecutor(new SynchronousExecutor())
                .build();
        WorkManagerTestInitHelper.initializeTestWorkManager(context, configuration);
    }

    @Test
    public void optionalPromptWorksWhileSignedOutAndOpensOnlyFixedApkUrl() throws Exception {
        AppRelease release = AppRelease.fromJson(AppReleaseTest.validJson(18, false));
        new AppUpdateStore(context).recordSuccess(release, System.currentTimeMillis());
        Intent browserIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(AppRelease.APK_URL));
        ResolveInfo browser = new ResolveInfo();
        browser.activityInfo = new ActivityInfo();
        browser.activityInfo.packageName = "test.browser";
        browser.activityInfo.name = "BrowserActivity";
        Shadows.shadowOf(context.getPackageManager()).addResolveInfoForIntent(browserIntent, browser);

        try (ActivityController<MainActivity> controller =
                     Robolectric.buildActivity(MainActivity.class).create()) {
            MainActivity activity = controller.get();
            AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();

            assertNotNull(dialog);
            assertTrue(dialog.isShowing());
            assertEquals("Update available", Shadows.shadowOf(dialog).getTitle().toString());
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
            Shadows.shadowOf(Looper.getMainLooper()).idle();

            Intent intent = Shadows.shadowOf(activity).getNextStartedActivity();
            assertNotNull(intent);
            assertEquals(Intent.ACTION_VIEW, intent.getAction());
            assertEquals(AppRelease.APK_URL, intent.getDataString());
        }
    }

    @Test
    public void requiredStateRemainsDismissibleAndDoesNotBlockSignedOutUi() throws Exception {
        AppRelease release = AppRelease.fromJson(AppReleaseTest.validJson(18, true));
        new AppUpdateStore(context).recordSuccess(release, System.currentTimeMillis());

        try (ActivityController<MainActivity> controller =
                     Robolectric.buildActivity(MainActivity.class).create()) {
            AlertDialog dialog = ShadowAlertDialog.getLatestAlertDialog();

            assertNotNull(dialog);
            assertEquals("Update required", Shadows.shadowOf(dialog).getTitle().toString());
            assertTrue(dialog.getButton(AlertDialog.BUTTON_NEGATIVE).isEnabled());
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).performClick();
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertFalse(new AppUpdateStore(context).shouldPrompt(
                    release, 17, System.currentTimeMillis()));
        }
    }
}
