package xyz.etherings.player.walk;

public final class WalkSubmissionResult {
    private final boolean success;
    private final boolean sessionExpired;
    private final String title;
    private final String message;
    private final String status;
    private final long acceptedSteps;
    private final long earnedErt;

    private WalkSubmissionResult(
            boolean success,
            boolean sessionExpired,
            String title,
            String message,
            String status,
            long acceptedSteps,
            long earnedErt
    ) {
        this.success = success;
        this.sessionExpired = sessionExpired;
        this.title = title == null ? "" : title;
        this.message = message == null ? "" : message;
        this.status = status == null ? "" : status;
        this.acceptedSteps = Math.max(0L, acceptedSteps);
        this.earnedErt = Math.max(0L, earnedErt);
    }

    public static WalkSubmissionResult accepted(long acceptedSteps, long earnedErt) {
        return new WalkSubmissionResult(
                true,
                false,
                "Walk accepted",
                "Accepted " + acceptedSteps + " steps, earned " + earnedErt + " ERT.",
                "ACCEPTED",
                acceptedSteps,
                earnedErt
        );
    }

    public static WalkSubmissionResult rejected(String reason) {
        String cleanReason = reason == null || reason.trim().isEmpty() ? "unknown reason" : reason.trim();
        return new WalkSubmissionResult(
                false,
                false,
                "Walk rejected",
                "Backend rejected this window: " + cleanReason + ". Local window was not reset.",
                "REJECTED",
                0L,
                0L
        );
    }

    public static WalkSubmissionResult retryable(String message) {
        return new WalkSubmissionResult(false, false, "Walk not submitted", message, "FAILED_RETRYABLE", 0L, 0L);
    }

    public static WalkSubmissionResult sessionExpired() {
        return new WalkSubmissionResult(false, true, "Session expired", "Sign in again before submitting steps.", "SESSION_EXPIRED", 0L, 0L);
    }

    public boolean isSuccess() {
        return success;
    }

    public boolean isSessionExpired() {
        return sessionExpired;
    }

    public String title() {
        return title;
    }

    public String message() {
        return message;
    }

    public String status() {
        return status;
    }

    public long acceptedSteps() {
        return acceptedSteps;
    }

    public long earnedErt() {
        return earnedErt;
    }
}
