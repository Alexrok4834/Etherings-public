package xyz.etherings.player.step;

public final class StepNotificationPresentation {
    private StepNotificationPresentation() {}

    public static String title() {
        return "EtheRings step tracking";
    }

    public static String content(boolean sensorAvailable, long dailySteps, Integer dailyLimit) {
        if (!sensorAvailable) {
            return "Step sensor unavailable";
        }
        return "Today: " + Math.max(0L, dailySteps)
                + " / " + (dailyLimit == null ? "--" : dailyLimit) + " steps";
    }
}
