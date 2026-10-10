package xyz.etherings.player.home;

import xyz.etherings.player.sync.SyncStatusSnapshot;

public final class WalkStatusPresentation {
    private final String localSteps;
    private final String rewardWindow;
    private final String acceptedSteps;
    private final String earnedErt;
    private final String deliveryStatus;

    private WalkStatusPresentation(
            String localSteps,
            String rewardWindow,
            String acceptedSteps,
            String earnedErt,
            String deliveryStatus
    ) {
        this.localSteps = localSteps;
        this.rewardWindow = rewardWindow;
        this.acceptedSteps = acceptedSteps;
        this.earnedErt = earnedErt;
        this.deliveryStatus = deliveryStatus;
    }

    public static WalkStatusPresentation from(
            long localStepsToday,
            long rewardWindowSteps,
            int acceptedStepsToday,
            String earnedErtTodayDisplay,
            SyncStatusSnapshot sync,
            String lastSuccessfulDelivery
    ) {
        long sendableSteps = Math.max(0L, sync.pendingSteps() - sync.heldSteps());
        int sendableBatches = Math.max(0, sync.pendingBatches() - sync.heldBatches());
        String queue;
        if (sync.authRequired()) {
            queue = "Delivery paused: sign in required";
        } else if (sendableBatches > 0) {
            queue = "Waiting to send: " + sendableSteps + " steps in "
                    + sendableBatches + " " + batchLabel(sendableBatches);
        } else if (sync.heldBatches() > 0) {
            queue = "No steps waiting to send";
        } else {
            queue = "Delivery queue: empty";
        }

        StringBuilder delivery = new StringBuilder(queue);
        if (sync.heldBatches() > 0) {
            delivery.append("\nHeld for review: ")
                    .append(sync.heldSteps()).append(" steps in ")
                    .append(sync.heldBatches()).append(" ").append(batchLabel(sync.heldBatches()))
                    .append(". Ring change timing could not be verified; no ERT credited.");
        }
        delivery
                .append("\nDelivered by this device (all time): ")
                .append(sync.syncedSteps())
                .append(" steps / ")
                .append(sync.syncedErtDisplay())
                .append(" ERT");
        if (sync.rejectedSteps() > 0L) {
            delivery.append("\nRejected by server (all time): ")
                    .append(sync.rejectedSteps())
                    .append(" steps");
        }
        delivery.append("\nLast successful delivery: ")
                .append(lastSuccessfulDelivery);

        return new WalkStatusPresentation(
                "On this phone today: " + Math.max(0L, localStepsToday) + " steps",
                "Current reward window: " + Math.max(0L, rewardWindowSteps) + " steps",
                "Accepted by server today: " + Math.max(0, acceptedStepsToday) + " steps",
                "ERT earned today: " + earnedErtTodayDisplay,
                delivery.toString()
        );
    }

    public String localSteps() {
        return localSteps;
    }

    public String rewardWindow() {
        return rewardWindow;
    }

    public String acceptedSteps() {
        return acceptedSteps;
    }

    public String earnedErt() {
        return earnedErt;
    }

    public String deliveryStatus() {
        return deliveryStatus;
    }

    private static String batchLabel(int count) {
        return count == 1 ? "batch" : "batches";
    }
}
