package xyz.etherings.player.home;

import org.json.JSONException;
import org.json.JSONObject;

import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.economy.EruValue;

/** Account-scoped Alpha economy read; ERU is supplied separately from the bound wallet. */
public final class AlphaHomeEconomySnapshot {
    private final String ownerId;
    private final String date;
    private final String ertDisplay;
    private final String eruDisplay;
    private final Integer dailyStepCap;

    private AlphaHomeEconomySnapshot(String ownerId, String date, String ertDisplay,
            String eruDisplay, Integer dailyStepCap) {
        this.ownerId = ownerId;
        this.date = date;
        this.ertDisplay = ertDisplay;
        this.eruDisplay = eruDisplay;
        this.dailyStepCap = dailyStepCap;
    }

    public static AlphaHomeEconomySnapshot from(JSONObject body, String ownerId,
            String expectedDate) throws JSONException {
        if (ownerId == null || ownerId.isEmpty() || !expectedDate.equals(body.getString("date")))
            throw new JSONException("Alpha economy date or owner mismatch");
        Object exact = body.get("ertBalanceExact");
        Object display = body.get("ertBalanceDisplay");
        if (!(exact instanceof String) || !(display instanceof String))
            throw new JSONException("Alpha ERT values must be exact strings");
        String ert = ErtValue.fromExactAndDisplay((String) exact, (String) display).display();
        if (!body.has("dailyStepCap")) throw new JSONException("Missing Alpha daily step cap");
        Integer cap = null;
        if (!body.isNull("dailyStepCap")) {
            Object value = body.get("dailyStepCap");
            if (!(value instanceof Integer) || (Integer) value <= 0)
                throw new JSONException("Invalid Alpha daily step cap");
            cap = (Integer) value;
        }
        return new AlphaHomeEconomySnapshot(ownerId, expectedDate, ert, null, cap);
    }

    public AlphaHomeEconomySnapshot withWalletEru(String exactEru) {
        return new AlphaHomeEconomySnapshot(ownerId, date, ertDisplay,
                EruValue.fromExact(exactEru).display(), dailyStepCap);
    }

    public String ownerId() { return ownerId; }
    public String date() { return date; }
    public String ertDisplay() { return ertDisplay; }
    public String eruDisplay() { return eruDisplay; }
    public Integer dailyStepCap() { return dailyStepCap; }
}
