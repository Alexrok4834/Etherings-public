package xyz.etherings.player.alpha;

public final class AlphaLaunchGate {
    private static String verifiedEmail;

    private AlphaLaunchGate() { }

    public static synchronized void grant(String email) {
        if (email == null || email.isEmpty()) throw new IllegalArgumentException("Verified email required");
        verifiedEmail = email;
    }

    public static synchronized boolean consume(String email) {
        boolean allowed = verifiedEmail != null && verifiedEmail.equals(email);
        verifiedEmail = null;
        return allowed;
    }
}
