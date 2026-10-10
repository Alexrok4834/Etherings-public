package xyz.etherings.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.graphics.Color;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class VisualTokensTest {
    private final Context context = ApplicationProvider.getApplicationContext();

    @Test
    public void approvedBrandColorsRemainStable() {
        int black = Color.rgb(23, 23, 23);
        int gold = Color.rgb(242, 193, 118);
        assertEquals(black, context.getColor(R.color.brand_black));
        assertEquals(black, context.getColor(R.color.brand_background));
        assertEquals(Color.rgb(24, 23, 19), context.getColor(R.color.brand_surface));
        assertEquals(Color.rgb(35, 33, 30), context.getColor(R.color.brand_surface_elevated));
        assertEquals(black, context.getColor(R.color.brand_on_accent));
        assertEquals(Color.rgb(43, 41, 38), context.getColor(R.color.brand_disabled_surface));
        assertEquals(gold, context.getColor(R.color.brand_gold));
        assertEquals(gold, context.getColor(R.color.brand_accent));
        assertEquals(Color.rgb(236, 193, 122), context.getColor(R.color.brand_accent_bright));
        assertEquals(Color.rgb(91, 74, 53), context.getColor(R.color.brand_outline));
        assertEquals(Color.rgb(245, 244, 241), context.getColor(R.color.brand_text_primary));
        assertEquals(Color.rgb(196, 187, 175), context.getColor(R.color.brand_text_secondary));
        assertEquals(Color.rgb(154, 145, 134), context.getColor(R.color.brand_text_subtle));
        assertEquals(Color.rgb(143, 136, 127), context.getColor(R.color.brand_disabled_text));
    }

    @Test
    public void operationalTextPairsMeetWcagAaContrast() {
        assertContrastAtLeast(R.color.brand_text_primary, R.color.brand_background, 4.5);
        assertContrastAtLeast(R.color.brand_text_secondary, R.color.brand_surface, 4.5);
        assertContrastAtLeast(R.color.brand_accent, R.color.brand_surface, 4.5);
        assertContrastAtLeast(R.color.brand_on_accent, R.color.brand_accent, 4.5);
        assertContrastAtLeast(R.color.brand_error, R.color.brand_surface, 4.5);
    }

    @Test
    public void controlsUseAccessibleAndRestrainedDimensions() {
        assertTrue(context.getResources().getDimensionPixelSize(R.dimen.touch_target)
                >= dp(48));
        assertEquals(dp(24), context.getResources().getDimensionPixelSize(
                R.dimen.attribute_plus_frame_size));
        assertEquals(dp(36), context.getResources().getDimensionPixelSize(
                R.dimen.attribute_action_slot_width));
        assertEquals(dp(12), context.getResources().getDimensionPixelSize(
                R.dimen.attribute_action_slot_width)
                - context.getResources().getDimensionPixelSize(R.dimen.attribute_plus_frame_size));
        assertEquals(dp(28), context.getResources().getDimensionPixelSize(
                R.dimen.ring_detail_row_height));
        assertTrue(context.getResources().getDimensionPixelSize(R.dimen.ring_detail_row_height)
                >= context.getResources().getDimensionPixelSize(R.dimen.attribute_plus_frame_size));
        assertEquals(dp(2), context.getResources().getDimensionPixelSize(
                R.dimen.ring_detail_row_gap));
        assertEquals(dp(8), context.getResources().getDimensionPixelSize(
                R.dimen.ring_detail_table_inset));
        assertTrue(context.getResources().getDimensionPixelSize(R.dimen.attribute_action_slot_width)
                <= context.getResources().getDimensionPixelSize(R.dimen.touch_target));
        assertTrue(context.getResources().getDimensionPixelSize(R.dimen.radius_control)
                <= dp(8));
        assertTrue(context.getResources().getDimensionPixelSize(R.dimen.radius_panel)
                <= dp(8));
    }

    @Test
    public void appShellResourcesArePackagedForApi28() {
        assertNotNull(context.getDrawable(R.drawable.etherings_logo_gold));
        assertNotNull(context.getDrawable(R.drawable.header_token_ert));
        assertNotNull(context.getDrawable(R.drawable.header_token_eru));
        assertNotNull(context.getDrawable(R.drawable.ic_step_notification));
        assertEquals(dp(48), context.getResources().getDimensionPixelSize(R.dimen.profile_entry_size));
        assertEquals(dp(56), context.getResources().getDimensionPixelSize(R.dimen.brand_logo_size));
        assertEquals(dp(20), context.getResources().getDimensionPixelSize(
                R.dimen.header_token_icon_size));
        assertNotEquals(R.id.header_ert_group, R.id.header_eru_group);
        assertNotEquals(R.id.header_ert_icon, R.id.header_eru_icon);
        assertNotEquals(R.id.header_ert_value, R.id.header_eru_value);
        assertNotEquals(R.id.mode_content, R.id.mode_tabs);
        assertNotEquals(R.id.auth_submit, R.id.auth_mode_toggle);
        assertNotEquals(R.id.registration_display_name, R.id.registration_password_confirmation);
        assertNotEquals(R.id.activity_history, R.id.activity_history_list);
        assertNotEquals(R.id.profile_activity_tabs, R.id.profile_activity_section);
        assertNotEquals(R.id.profile_activity_section, R.id.profile_draw_history_section);
        assertNotEquals(R.id.profile_version, R.id.sign_out);
        assertNotEquals(R.id.raffle_v2_wheel, R.id.raffle_v2_attempts);
        assertNotEquals(R.id.raffle_v2_attempts, R.id.raffle_v2_action);
        assertNotEquals(R.id.raffle_v2_action, R.id.raffle_v2_reward_artwork);
        assertNotEquals(R.id.copper_ring_inventory, R.id.copper_ring_detail_metrics);
        assertNotEquals(R.id.mode_draw, R.id.mode_home);
        assertNotEquals(R.id.mode_home, R.id.mode_rings);
    }

    private void assertContrastAtLeast(int foregroundId, int backgroundId, double minimum) {
        int foreground = context.getColor(foregroundId);
        int background = context.getColor(backgroundId);
        double lighter = Math.max(luminance(foreground), luminance(background));
        double darker = Math.min(luminance(foreground), luminance(background));
        assertTrue((lighter + 0.05) / (darker + 0.05) >= minimum);
    }

    private double luminance(int color) {
        return 0.2126 * linear(Color.red(color))
                + 0.7152 * linear(Color.green(color))
                + 0.0722 * linear(Color.blue(color));
    }

    private double linear(int component) {
        double value = component / 255.0;
        return value <= 0.04045
                ? value / 12.92
                : Math.pow((value + 0.055) / 1.055, 2.4);
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
