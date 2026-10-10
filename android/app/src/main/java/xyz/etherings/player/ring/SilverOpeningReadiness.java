package xyz.etherings.player.ring;

import org.json.JSONObject;

public final class SilverOpeningReadiness {
    private static final String ADDRESS = "[1-9A-HJ-NP-Za-km-z]{32,44}";
    public final String escrowAddress;

    private SilverOpeningReadiness(String escrowAddress) {
        this.escrowAddress = escrowAddress;
    }

    public static SilverOpeningReadiness parse(JSONObject body, String mint) throws Exception {
        return parse(body, mint, false);
    }

    public static SilverOpeningReadiness parse(JSONObject body, String mint,
            boolean signingEnabled) throws Exception {
        if (!"devnet".equals(body.getString("cluster")) ||
                !mint.equals(body.getString("mintAddress")) ||
                body.getBoolean("signingEnabled") != signingEnabled ||
                !body.getString("walletAddress").matches(ADDRESS) ||
                !body.getString("escrowAddress").matches(ADDRESS)) {
            throw new IllegalArgumentException("Silver opening preflight mismatch");
        }
        return new SilverOpeningReadiness(body.getString("escrowAddress"));
    }
}
