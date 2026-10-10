package xyz.etherings.player.economy;

import org.json.JSONException;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.regex.Pattern;

public final class ErtValue {
    private static final Pattern EXACT_PATTERN = Pattern.compile("(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,18})?");
    private static final Pattern DISPLAY_PATTERN = Pattern.compile("(?:0|[1-9][0-9]*)\\.[0-9]{2}");

    private final String exact;
    private final String display;

    private ErtValue(String exact, String display) {
        this.exact = exact;
        this.display = display;
    }

    public static ErtValue zero() {
        return new ErtValue("0", "0.00");
    }

    public static ErtValue fromExact(String exact) {
        try {
            validateExact(exact, "exact ERT");
        } catch (JSONException error) {
            throw new IllegalArgumentException(error.getMessage(), error);
        }
        return new ErtValue(exact, formatDisplay(exact));
    }

    public static ErtValue fromExactAndDisplay(String exact, String display) {
        ErtValue value = fromExact(exact);
        if (display == null
                || !DISPLAY_PATTERN.matcher(display).matches()
                || !value.display.equals(display)) {
            throw new IllegalArgumentException("display ERT does not match the exact value");
        }
        return value;
    }

    public ErtValue add(ErtValue other) {
        if (other == null) {
            throw new IllegalArgumentException("other ERT value is required");
        }
        BigDecimal total = new BigDecimal(exact).add(new BigDecimal(other.exact));
        String normalized = total.signum() == 0
                ? "0"
                : total.stripTrailingZeros().toPlainString();
        return fromExact(normalized);
    }

    public int compareTo(ErtValue other) {
        if (other == null) {
            throw new IllegalArgumentException("other ERT value is required");
        }
        return new BigDecimal(exact).compareTo(new BigDecimal(other.exact));
    }

    public ErtValue subtract(ErtValue other) {
        if (other == null) {
            throw new IllegalArgumentException("other ERT value is required");
        }
        BigDecimal difference = new BigDecimal(exact).subtract(new BigDecimal(other.exact));
        if (difference.signum() < 0) {
            throw new IllegalArgumentException("ERT subtraction cannot produce a negative value");
        }
        String normalized = difference.signum() == 0
                ? "0"
                : difference.stripTrailingZeros().toPlainString();
        return fromExact(normalized);
    }

    public boolean isZero() {
        return new BigDecimal(exact).signum() == 0;
    }

    public static ErtValue fromJson(
            JSONObject object,
            String exactKey,
            String displayKey,
            String legacyKey
    ) throws JSONException {
        if (object == null) {
            return zero();
        }
        if (!object.isNull(exactKey)) {
            Object rawExact = object.get(exactKey);
            if (!(rawExact instanceof String)) {
                throw new JSONException(exactKey + " must be a canonical decimal string");
            }
            String exact = (String) rawExact;
            validateExact(exact, exactKey);
            String calculatedDisplay = formatDisplay(exact);
            if (object.isNull(displayKey)) {
                throw new JSONException(displayKey + " is required with the exact ERT value");
            }
            Object rawDisplay = object.get(displayKey);
            if (!(rawDisplay instanceof String)
                    || !DISPLAY_PATTERN.matcher((String) rawDisplay).matches()
                    || !calculatedDisplay.equals(rawDisplay)) {
                throw new JSONException(displayKey + " does not match the exact ERT value");
            }
            return new ErtValue(exact, calculatedDisplay);
        }

        if (object.isNull(legacyKey)) {
            return zero();
        }
        Object legacy = object.get(legacyKey);
        if (!(legacy instanceof Byte || legacy instanceof Short || legacy instanceof Integer || legacy instanceof Long)) {
            throw new JSONException(legacyKey + " must be a non-negative integer fallback");
        }
        long value = ((Number) legacy).longValue();
        if (value < 0L) {
            throw new JSONException(legacyKey + " must be non-negative");
        }
        String exact = Long.toString(value);
        return new ErtValue(exact, formatDisplay(exact));
    }

    public String exact() {
        return exact;
    }

    public String display() {
        return display;
    }

    public long wholeUnitsFloor() {
        try {
            return new BigDecimal(exact).setScale(0, RoundingMode.FLOOR).longValueExact();
        } catch (ArithmeticException error) {
            throw new IllegalStateException("ERT value exceeds Android compatibility range", error);
        }
    }

    public JSONObject writeTo(JSONObject object, String exactKey, String displayKey, String legacyKey)
            throws JSONException {
        return object
                .put(legacyKey, wholeUnitsFloor())
                .put(exactKey, exact)
                .put(displayKey, display);
    }

    private static void validateExact(String exact, String field) throws JSONException {
        if (exact == null || !EXACT_PATTERN.matcher(exact).matches()) {
            throw new JSONException(field + " must be a canonical non-negative ERT value");
        }
    }

    private static String formatDisplay(String exact) {
        return new BigDecimal(exact).setScale(2, RoundingMode.HALF_UP).toPlainString();
    }
}
