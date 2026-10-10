package xyz.etherings.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertSame;
import static org.junit.Assert.assertTrue;

import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.test.core.app.ApplicationProvider;
import androidx.work.Configuration;
import androidx.work.testing.SynchronousExecutor;
import androidx.work.testing.WorkManagerTestInitHelper;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;

import java.lang.reflect.Field;

import xyz.etherings.player.home.HomeProfile;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class SignedOutNavigationTest {
    @Before
    public void setUpWorkManager() {
        Configuration configuration = new Configuration.Builder()
                .setExecutor(new SynchronousExecutor())
                .build();
        WorkManagerTestInitHelper.initializeTestWorkManager(
                ApplicationProvider.getApplicationContext(),
                configuration
        );
    }

    @Test
    public void bottomTabsCannotRevealAccountViewsWithoutAuthenticatedProfile() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create()) {
            MainActivity activity = controller.get();
            TextView acceptedSteps = activity.findViewById(R.id.accepted_steps_today);
            TextView activityHistory = activity.findViewById(R.id.activity_history);

            acceptedSteps.setText("Accepted by server today: 477 steps");
            acceptedSteps.setVisibility(View.VISIBLE);
            activityHistory.setVisibility(View.VISIBLE);

            assertSignedOutAfterSelecting(activity, R.id.mode_draw, acceptedSteps, activityHistory);
            assertSignedOutAfterSelecting(activity, R.id.mode_home, acceptedSteps, activityHistory);
            assertSignedOutAfterSelecting(activity, R.id.mode_rings, acceptedSteps, activityHistory);
        }
    }

    @Test
    public void signedOutScreenOnlyShowsBrandAndAuthenticationControls() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create()) {
            MainActivity activity = controller.get();

            assertEquals(View.VISIBLE, activity.findViewById(R.id.brand_logo).getVisibility());
            assertEquals(View.GONE, activity.findViewById(R.id.profile_entry).getVisibility());
            assertEquals(View.GONE, activity.findViewById(R.id.header_balances).getVisibility());
            assertEquals(View.GONE, activity.findViewById(R.id.step_status_block).getVisibility());
            assertEquals(View.GONE, activity.findViewById(R.id.mode_tabs).getVisibility());
            assertEquals(View.VISIBLE, activity.findViewById(R.id.auth_submit).getVisibility());
            assertEquals(View.VISIBLE, activity.findViewById(R.id.auth_mode_toggle).getVisibility());
            assertEquals(View.GONE, activity.findViewById(R.id.activity_history).getVisibility());
            assertEquals(View.GONE, activity.findViewById(R.id.profile_version).getVisibility());
            assertEquals(View.GONE, activity.findViewById(R.id.copper_ring_artwork).getVisibility());

            activity.findViewById(R.id.auth_mode_toggle).performClick();

            assertEquals(View.VISIBLE, activity.findViewById(R.id.registration_display_name).getVisibility());
            assertEquals(
                    View.VISIBLE,
                    activity.findViewById(R.id.registration_password_confirmation).getVisibility()
            );
            assertEquals(View.GONE, activity.findViewById(R.id.mode_tabs).getVisibility());
        }
    }

    @Test
    public void authenticatedProfileEndsWithPackagedVersionFooter() throws Exception {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create()) {
            MainActivity activity = controller.get();
            Field profileField = MainActivity.class.getDeclaredField("currentProfile");
            profileField.setAccessible(true);
            profileField.set(activity, HomeProfile.offlineOwner(
                    "11111111-1111-4111-8111-111111111111"));

            View profileEntry = activity.findViewById(R.id.profile_entry);
            profileEntry.setVisibility(View.VISIBLE);
            profileEntry.performClick();

            TextView version = activity.findViewById(R.id.profile_version);
            TextView retry = activity.findViewById(R.id.profile_retry);
            LinearLayout panel = activity.findViewById(R.id.mode_content);
            assertEquals(View.VISIBLE, version.getVisibility());
            assertEquals(View.GONE, retry.getVisibility());
            assertEquals("MVP v. 1." + BuildConfig.VERSION_NAME,
                    version.getText().toString());
            assertSame(version, panel.getChildAt(panel.getChildCount() - 1));
            assertFalse(version.hasOnClickListeners());
            assertEquals(0, version.getMinimumHeight());
            assertEquals(1, version.getMaxLines());
        }
    }

    @Test
    public void headerKeepsCenteredBrandAndUsesAccessibleTokenGroups() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create()) {
            MainActivity activity = controller.get();
            LinearLayout brandHeader = activity.findViewById(R.id.brand_header);
            LinearLayout balances = activity.findViewById(R.id.header_balances);
            ImageView ertIcon = activity.findViewById(R.id.header_ert_icon);
            ImageView eruIcon = activity.findViewById(R.id.header_eru_icon);

            assertEquals(3, brandHeader.getChildCount());
            View profileSlot = brandHeader.getChildAt(0);
            View balanceSlot = brandHeader.getChildAt(2);
            LinearLayout.LayoutParams profileParams =
                    (LinearLayout.LayoutParams) profileSlot.getLayoutParams();
            LinearLayout.LayoutParams balanceParams =
                    (LinearLayout.LayoutParams) balanceSlot.getLayoutParams();
            assertEquals(0, profileParams.width);
            assertEquals(0, balanceParams.width);
            assertEquals(profileParams.weight, balanceParams.weight, 0f);
            assertSame(balanceSlot, balances.getParent());

            assertEquals(2, balances.getChildCount());
            assertEquals(R.id.header_ert_group, balances.getChildAt(0).getId());
            assertEquals(R.id.header_eru_group, balances.getChildAt(1).getId());
            assertEquals("ERT token", ertIcon.getContentDescription().toString());
            assertEquals("ERU token", eruIcon.getContentDescription().toString());
            int iconSize = activity.getResources().getDimensionPixelSize(
                    R.dimen.header_token_icon_size);
            assertEquals(iconSize, ertIcon.getLayoutParams().width);
            assertEquals(iconSize, ertIcon.getLayoutParams().height);
            assertEquals(iconSize, eruIcon.getLayoutParams().width);
            assertEquals(iconSize, eruIcon.getLayoutParams().height);
            assertEquals(ViewGroup.LayoutParams.MATCH_PARENT, balances.getLayoutParams().width);
            assertEquals(ViewGroup.LayoutParams.WRAP_CONTENT,
                    balances.getChildAt(0).getLayoutParams().width);
            assertEquals(ViewGroup.LayoutParams.WRAP_CONTENT,
                    balances.getChildAt(1).getLayoutParams().width);
            assertEquals(ViewGroup.LayoutParams.WRAP_CONTENT,
                    activity.findViewById(R.id.header_ert_value).getLayoutParams().width);
            assertEquals(ViewGroup.LayoutParams.WRAP_CONTENT,
                    activity.findViewById(R.id.header_eru_value).getLayoutParams().width);
            assertEquals("--", ((TextView) activity.findViewById(R.id.header_ert_value))
                    .getText().toString());
            assertEquals("--", ((TextView) activity.findViewById(R.id.header_eru_value))
                    .getText().toString());
        }
    }

    @Test
    public void compactHeaderKeepsTokenGroupsInsideBalancedSlot() {
        try (ActivityController<MainActivity> controller = Robolectric.buildActivity(MainActivity.class).create()) {
            MainActivity activity = controller.get();
            LinearLayout brandHeader = activity.findViewById(R.id.brand_header);
            LinearLayout balances = activity.findViewById(R.id.header_balances);
            View brandLogo = activity.findViewById(R.id.brand_logo);
            View ertIcon = activity.findViewById(R.id.header_ert_icon);
            View eruIcon = activity.findViewById(R.id.header_eru_icon);
            View balanceSlot = brandHeader.getChildAt(2);
            balances.setVisibility(View.VISIBLE);
            ((TextView) activity.findViewById(R.id.header_ert_value)).setText("999.99");
            ((TextView) activity.findViewById(R.id.header_eru_value)).setText("999.99");

            int compactWidth = Math.round(288 * activity.getResources()
                    .getDisplayMetrics().density);
            brandHeader.measure(
                    View.MeasureSpec.makeMeasureSpec(compactWidth, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
            );
            brandHeader.layout(0, 0, compactWidth, brandHeader.getMeasuredHeight());

            assertEquals(compactWidth / 2,
                    (brandLogo.getLeft() + brandLogo.getRight()) / 2,
                    1);
            assertEquals(balanceSlot.getWidth(), balances.getWidth());
            assertTrue(balances.getChildAt(0).getWidth()
                    + balances.getChildAt(1).getWidth()
                    + ((LinearLayout.LayoutParams) balances.getChildAt(1)
                    .getLayoutParams()).getMarginStart() <= balanceSlot.getWidth());
            assertEquals(activity.getResources().getDimensionPixelSize(R.dimen.space_xs),
                    activity.findViewById(R.id.header_ert_value).getLeft() - ertIcon.getRight());
            assertEquals(activity.getResources().getDimensionPixelSize(R.dimen.space_xs),
                    activity.findViewById(R.id.header_eru_value).getLeft() - eruIcon.getRight());
        }
    }

    private static void assertSignedOutAfterSelecting(
            MainActivity activity,
            int tabId,
            TextView acceptedSteps,
            TextView activityHistory
    ) {
        activity.findViewById(tabId).performClick();

        assertEquals(View.GONE, acceptedSteps.getVisibility());
        assertEquals(View.GONE, activityHistory.getVisibility());
        assertEquals(View.VISIBLE, activity.findViewById(R.id.auth_submit).getVisibility());
        assertEquals("--", ((TextView) activity.findViewById(R.id.header_ert_value))
                .getText().toString());
        assertEquals("--", ((TextView) activity.findViewById(R.id.header_eru_value))
                .getText().toString());
    }
}
