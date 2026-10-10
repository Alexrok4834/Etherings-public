package xyz.etherings.player.economy;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.BigInteger;
import java.math.RoundingMode;
import java.util.regex.Pattern;

public final class EruValue {
    private static final Pattern LEGACY_INTEGER_PATTERN = Pattern.compile("(?:0|[1-9][0-9]{0,47})");
    private static final Pattern DECIMAL_PATTERN = Pattern.compile(
            "(?:0|[1-9][0-9]{0,29})\\.[0-9]{1,18}"
    );
    private static final Pattern DISPLAY_PATTERN = Pattern.compile("(?:0|[1-9][0-9]*)\\.[0-9]{2}");
    private static final BigInteger MAX_SAFE_COMPATIBILITY_VALUE =
            new BigInteger("9007199254740991");

    private final String exact;
    private final String display;

    private EruValue(String exact, String display) {
        this.exact = exact;
        this.display = display;
    }

    public static EruValue zero() {
        return new EruValue("0", "0.00");
    }

    public static EruValue fromExact(String exact) {
        try {
            validateExact(exact, "exact ERU");
        } catch (JSONException error) {
            throw new IllegalArgumentException(error.getMessage(), error);
        }
        return new EruValue(exact, formatDisplay(exact));
    }

    public static EruValue fromExactAndDisplay(String exact, String display) {
        EruValue value = fromExact(exact);
        boolean legacyWholeDisplay = LEGACY_INTEGER_PATTERN.matcher(exact).matches()
                && exact.equals(display);
        if (!legacyWholeDisplay && (display == null
                || !DISPLAY_PATTERN.matcher(display).matches()
                || !value.display.equals(display))) {
            throw new IllegalArgumentException("display ERU does not match the exact value");
        }
        return value;
    }

    public static EruValue fromJson(
            JSONObject object,
            String exactKey,
            String displayKey,
            String legacyKey
    ) throws JSONException {
        if (object == null) return zero();

        if (!object.isNull(exactKey)) {
            Object rawExact = object.get(exactKey);
            if (!(rawExact instanceof String)) {
                throw new JSONException(exactKey + " must be a canonical integer string");
            }
            String exact = (String) rawExact;
            validateExact(exact, exactKey);
            String display = formatDisplay(exact);
            if (!object.isNull(displayKey)) {
                Object rawDisplay = object.get(displayKey);
                try {
                    return fromExactAndDisplay(exact,
                            rawDisplay instanceof String ? (String) rawDisplay : null);
                } catch (IllegalArgumentException error) {
                    throw new JSONException(displayKey + " does not match the exact ERU value");
                }
            }
            return new EruValue(exact, display);
        }

        if (object.isNull(legacyKey)) return zero();
        Object legacy = object.get(legacyKey);
        if (!(legacy instanceof Byte || legacy instanceof Short
                || legacy instanceof Integer || legacy instanceof Long)) {
            throw new JSONException(legacyKey + " must be a non-negative integer fallback");
        }
        long value = ((Number) legacy).longValue();
        if (value < 0L) throw new JSONException(legacyKey + " must be non-negative");
        String exact = Long.toString(value);
        return new EruValue(exact, formatDisplay(exact));
    }

    public String exact() {
        return exact;
    }

    public String display() {
        return display;
    }

    public boolean isZero() {
        return new BigDecimal(exact).signum() == 0;
    }

    public JSONObject writeTo(JSONObject object, String exactKey, String displayKey, String legacyKey)
            throws JSONException {
        BigDecimal value = new BigDecimal(exact);
        Object compatibility = JSONObject.NULL;
        try {
            BigInteger integer = value.toBigIntegerExact();
            if (integer.compareTo(MAX_SAFE_COMPATIBILITY_VALUE) <= 0) {
                compatibility = integer.longValue();
            }
        } catch (ArithmeticException ignored) {
            // Fractional values have no lossless legacy integer representation.
        }
        return object
                .put(legacyKey, compatibility)
                .put(exactKey, exact)
                .put(displayKey, display);
    }

    private static void validateExact(String exact, String field) throws JSONException {
        if (exact == null || (!LEGACY_INTEGER_PATTERN.matcher(exact).matches()
                && !DECIMAL_PATTERN.matcher(exact).matches())) {
            throw new JSONException(field + " must be a canonical non-negative ERU decimal");
        }
    }

    private static String formatDisplay(String exact) {
        return new BigDecimal(exact).setScale(2, RoundingMode.HALF_UP).toPlainString();
    }
}
