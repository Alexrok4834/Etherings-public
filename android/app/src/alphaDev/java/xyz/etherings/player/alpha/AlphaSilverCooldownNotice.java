package xyz.etherings.player.alpha;

import org.json.JSONObject;
import java.text.DateFormat;
import java.util.Date;

/** Shared presentation of an authoritative Silver direct-transfer cooldown. */
final class AlphaSilverCooldownNotice {
    static final String PREFIX = "This NFT is in transfer cooldown.";

    private AlphaSilverCooldownNotice() { }

    static String forResponse(int status, JSONObject body) {
        if (status != 409 || body == null) return null;
        String code = body.optString("code");
        if (!"MARKETPLACE_LISTING_COOLDOWN".equals(code) &&
                !"SILVER_RING_COOLDOWN".equals(code)) return null;
        String until = body.optString("cooldownUntilUnixSeconds");
        try {
            if (!until.matches("[1-9][0-9]*")) throw new NumberFormatException();
            long millis = Math.multiplyExact(Long.parseLong(until), 1000L);
            return PREFIX + " You can use it after " +
                    DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
                            .format(new Date(millis)) + " (device time).";
        } catch (ArithmeticException | NumberFormatException ignored) {
            return PREFIX + " Try using it after cooldown ends.";
        }
    }
}
