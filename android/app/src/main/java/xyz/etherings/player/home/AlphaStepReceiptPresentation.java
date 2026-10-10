package xyz.etherings.player.home;

import xyz.etherings.player.sync.SyncStatusSnapshot;

/** Local-device receipts only; account-wide daily acceptance and balance require the server. */
public final class AlphaStepReceiptPresentation {
    private final String progress;
    private final String localSteps;
    private final String rewardWindow;
    private final String deliveryStatus;

    private AlphaStepReceiptPresentation(WalkStatusPresentation existing, long todaySteps,
            Integer dailyStepCap) {
        progress = todaySteps + " / " + (dailyStepCap == null ? "--" : dailyStepCap) + " steps";
        localSteps = existing.localSteps();
        rewardWindow = existing.rewardWindow();
        deliveryStatus = existing.deliveryStatus();
    }

    public static AlphaStepReceiptPresentation from(long dailySteps, long rewardWindowSteps,
            String snapshotDate, String today, SyncStatusSnapshot sync, String lastDelivery,
            Integer dailyStepCap) {
        long todaySteps = today != null && today.equals(snapshotDate) ? Math.max(0L, dailySteps) : 0L;
        long todayWindow = today != null && today.equals(snapshotDate)
                ? Math.max(0L, rewardWindowSteps) : 0L;
        WalkStatusPresentation existing = WalkStatusPresentation.from(
                todaySteps, todayWindow, 0, "--", sync, lastDelivery);
        return new AlphaStepReceiptPresentation(existing, todaySteps, dailyStepCap);
    }

    public String progress() { return progress; }
    public String localSteps() { return localSteps; }
    public String rewardWindow() { return rewardWindow; }
    public String deliveryStatus() { return deliveryStatus; }
}
