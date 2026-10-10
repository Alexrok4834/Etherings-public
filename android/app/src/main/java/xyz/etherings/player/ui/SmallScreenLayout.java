package xyz.etherings.player.ui;

public final class SmallScreenLayout {
    private static final int MIN_ACTIVITY_LIST_DP = 160;
    private static final int MAX_ACTIVITY_LIST_DP = 360;

    private SmallScreenLayout() {}

    public static int activityDialogListHeightPx(int screenHeightPx, float density) {
        float safeDensity = density > 0f ? density : 1f;
        int minimum = Math.round(MIN_ACTIVITY_LIST_DP * safeDensity);
        int maximum = Math.round(MAX_ACTIVITY_LIST_DP * safeDensity);
        int halfScreen = Math.max(0, screenHeightPx) / 2;
        return Math.max(minimum, Math.min(maximum, halfScreen));
    }
}
