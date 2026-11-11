package xyz.etherings.player.alpha;

import android.util.Log;

/** Failure-only diagnostics: no response bodies, messages, tokens or asset identities. */
public final class AlphaDisplayDiagnostics {
    public enum Stage { HOME_READ, RINGS_STARTER, RINGS_INVENTORY, RINGS_EQUIPMENT,
        PREVIEW_FILE, PREVIEW_RENDER, DISPLAY_REVISION, RINGS_REJECT, HOME_REJECT }
    private AlphaDisplayDiagnostics() { }

    public static void failure(Stage stage, Throwable error) {
        Throwable root = error;
        for (int depth = 0; depth < 8 && root != null && root.getCause() != null; depth++)
            root = root.getCause();
        // Categories, not arbitrary exception class/message strings from a provider.
        String kind = root instanceof java.net.SocketTimeoutException ? "timeout" :
                root instanceof java.io.IOException ? "io" :
                root instanceof org.json.JSONException ? "json" :
                root instanceof IllegalArgumentException ? "validation" :
                root instanceof IllegalStateException ? "state" : "other";
        Log.w("AlphaDisplay", stage.name() + " failure=" + kind);
    }

    public static void rejected(Stage stage, boolean revisionChanged, boolean first,
            boolean second, boolean third) {
        Log.w("AlphaDisplay", stage.name() + " revisionChanged=" + revisionChanged +
                " first=" + first + " second=" + second + " third=" + third);
    }

    public static void http(boolean starter, boolean collection, int status) {
        Log.w("AlphaDisplay", (starter ? "starter" : collection ? "collection" : "inventory") +
                " http=" + status);
    }
}
