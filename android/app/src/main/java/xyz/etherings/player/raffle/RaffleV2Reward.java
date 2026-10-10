package xyz.etherings.player.raffle;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigInteger;

import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.economy.EruValue;

public final class RaffleV2Reward {
    public enum Type { ERT, ERU, COPPER_RING }

    private final String rewardId;
    private final String code;
    private final String title;
    private final Type type;
    private final int segmentIndex;
    private final long weight;
    private final long probabilityDenominator;
    private final String amountExact;
    private final String amountDisplay;
    private final String imageUrl;

    private RaffleV2Reward(String rewardId, String code, String title, Type type,
            int segmentIndex, long weight, long probabilityDenominator,
            String amountExact, String amountDisplay, String imageUrl) {
        this.rewardId = rewardId;
        this.code = code;
        this.title = title;
        this.type = type;
        this.segmentIndex = segmentIndex;
        this.weight = weight;
        this.probabilityDenominator = probabilityDenominator;
        this.amountExact = amountExact;
        this.amountDisplay = amountDisplay;
        this.imageUrl = imageUrl;
    }

    static RaffleV2Reward fromJson(JSONObject json, long expectedDenominator) throws JSONException {
        String rewardId = RaffleV2Json.uuid(json, "rewardId");
        String code = RaffleV2Json.text(json, "code", 64);
        String title = RaffleV2Json.text(json, "title", 128);
        Type type;
        try {
            type = Type.valueOf(RaffleV2Json.text(json, "type", 32));
        } catch (IllegalArgumentException error) {
            throw new JSONException("Unsupported Raffle v2 reward type");
        }
        int segmentIndex = RaffleV2Json.nonNegativeInt(json, "segmentIndex");
        long weight = RaffleV2Json.positiveLongString(json, "weight");
        JSONObject probability = json.getJSONObject("probability");
        long numerator = RaffleV2Json.positiveLongString(probability, "numerator");
        long denominator = RaffleV2Json.positiveLongString(probability, "denominator");
        if (numerator != weight || denominator != expectedDenominator) {
            throw new JSONException("Reward probability does not match its exact weight");
        }
        String imageUrl = json.isNull("imageUrl") ? null : RaffleV2Json.text(json, "imageUrl", 512);
        String amountExact = null;
        String amountDisplay = null;
        if (type == Type.ERT) {
            amountExact = RaffleV2Json.text(json, "amountExact", 48);
            amountDisplay = RaffleV2Json.text(json, "amountDisplay", 64);
            ErtValue value;
            try {
                value = ErtValue.fromExactAndDisplay(amountExact, amountDisplay);
            } catch (IllegalArgumentException error) {
                throw new JSONException(error.getMessage());
            }
            if (value.isZero()) throw new JSONException("ERT reward amount must be positive");
        } else if (type == Type.ERU) {
            amountExact = RaffleV2Json.text(json, "amountExact", 64);
            amountDisplay = RaffleV2Json.text(json, "amountDisplay", 64);
            EruValue value;
            try {
                value = EruValue.fromExactAndDisplay(amountExact, amountDisplay);
            } catch (IllegalArgumentException error) {
                throw new JSONException(error.getMessage());
            }
            if (value.isZero()) throw new JSONException("ERU reward amount must be positive");
            amountDisplay = value.display();
        } else {
            if (!json.isNull("amountExact")) throw new JSONException("Cooper reward cannot carry currency");
            JSONObject asset = json.getJSONObject("asset");
            if (!"RING".equals(asset.optString("kind"))
                    || !"COPPER".equals(asset.optString("rarity"))
                    || !"Cooper".equals(asset.optString("displayRarity"))
                    || asset.optInt("quantity", -1) != 1) {
                throw new JSONException("Invalid Cooper reward asset");
            }
        }
        return new RaffleV2Reward(rewardId, code, title, type, segmentIndex, weight,
                denominator, amountExact, amountDisplay, imageUrl);
    }

    public String rewardId() { return rewardId; }
    public String code() { return code; }
    public String title() { return title; }
    public Type type() { return type; }
    public int segmentIndex() { return segmentIndex; }
    public long weight() { return weight; }
    public long probabilityDenominator() { return probabilityDenominator; }
    public String amountExact() { return amountExact; }
    public String amountDisplay() { return amountDisplay; }
    public String imageUrl() { return imageUrl; }
}

final class RaffleV2Json {
    private static final java.util.regex.Pattern UUID_V4 = java.util.regex.Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static final java.util.regex.Pattern POSITIVE = java.util.regex.Pattern.compile("[1-9][0-9]*");

    private RaffleV2Json() {}

    static String text(JSONObject json, String key, int max) throws JSONException {
        Object raw = json.get(key);
        if (!(raw instanceof String)) throw new JSONException(key + " must be a string");
        String value = (String) raw;
        if (value.isEmpty() || value.length() > max || !value.equals(value.trim())) {
            throw new JSONException(key + " is invalid");
        }
        return value;
    }

    static String uuid(JSONObject json, String key) throws JSONException {
        String value = text(json, key, 36);
        if (!UUID_V4.matcher(value).matches()) throw new JSONException(key + " must be a lowercase UUID v4");
        return value;
    }

    static int nonNegativeInt(JSONObject json, String key) throws JSONException {
        Object raw = json.get(key);
        if (!(raw instanceof Integer)) throw new JSONException(key + " must be an integer");
        int value = (Integer) raw;
        if (value < 0) throw new JSONException(key + " must be non-negative");
        return value;
    }

    static long positiveLongString(JSONObject json, String key) throws JSONException {
        Object raw = json.get(key);
        if (!(raw instanceof String) || !POSITIVE.matcher((String) raw).matches()) {
            throw new JSONException(key + " must be a canonical positive integer string");
        }
        try {
            BigInteger value = new BigInteger((String) raw);
            if (value.bitLength() > 63) throw new ArithmeticException("long overflow");
            return value.longValue();
        } catch (ArithmeticException error) {
            throw new JSONException(key + " exceeds the Android geometry range");
        }
    }
}
