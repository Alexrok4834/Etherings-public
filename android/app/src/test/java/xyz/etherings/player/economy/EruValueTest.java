package xyz.etherings.player.economy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class EruValueTest {
    @Test
    public void preservesExactFortyEightDigitValueWithoutNumericCompatibility() throws Exception {
        String exact = "999999999999999999999999999999999999999999999999";
        JSONObject source = new JSONObject()
                .put("value", JSONObject.NULL)
                .put("valueExact", exact)
                .put("valueDisplay", exact);

        EruValue value = EruValue.fromJson(source, "valueExact", "valueDisplay", "value");
        JSONObject cached = value.writeTo(new JSONObject(), "valueExact", "valueDisplay", "value");

        assertEquals(exact, value.exact());
        assertEquals(exact + ".00", value.display());
        assertEquals(JSONObject.NULL, cached.get("value"));
        assertEquals(exact, cached.getString("valueExact"));
        assertEquals(exact + ".00", cached.getString("valueDisplay"));
    }

    @Test
    public void acceptsSafeLegacyIntegerDuringInstallOver() throws Exception {
        EruValue value = EruValue.fromJson(
                new JSONObject().put("value", 30), "valueExact", "valueDisplay", "value"
        );
        assertEquals("30", value.exact());
        assertEquals("30.00", value.display());
    }

    @Test
    public void acceptsDecimalAndVerifiesHalfUpDisplay() throws Exception {
        EruValue value = EruValue.fromJson(new JSONObject()
                        .put("valueExact", "1.235").put("valueDisplay", "1.24"),
                "valueExact", "valueDisplay", "value");
        JSONObject cached = value.writeTo(new JSONObject(), "valueExact", "valueDisplay", "value");

        assertEquals("1.235", value.exact());
        assertEquals("1.24", value.display());
        assertEquals(JSONObject.NULL, cached.get("value"));
        assertEquals("1.235", cached.getString("valueExact"));
        assertEquals("1.24", cached.getString("valueDisplay"));
    }

    @Test
    public void acceptsLegacyWholeDisplayAndRewritesItAsV2() throws Exception {
        EruValue value = EruValue.fromJson(new JSONObject()
                        .put("valueExact", "30").put("valueDisplay", "30"),
                "valueExact", "valueDisplay", "value");

        assertEquals("30.00", value.display());
        assertEquals("30.00", value.writeTo(new JSONObject(), "e", "d", "v").getString("d"));
    }

    @Test
    public void rejectsMismatchedMalformedAndOutOfRangeValues() {
        assertThrows(org.json.JSONException.class, () -> EruValue.fromJson(new JSONObject()
                        .put("valueExact", "30").put("valueDisplay", "030"),
                "valueExact", "valueDisplay", "value"));
        assertThrows(IllegalArgumentException.class, () -> EruValue.fromExact("1e-3"));
        assertThrows(IllegalArgumentException.class,
                () -> EruValue.fromExact("1.1234567890123456789"));
        assertThrows(IllegalArgumentException.class,
                () -> EruValue.fromExact("1000000000000000000000000000000.1"));
        assertThrows(IllegalArgumentException.class,
                () -> EruValue.fromExact("1000000000000000000000000000000000000000000000000"));
        assertThrows(org.json.JSONException.class, () -> EruValue.fromJson(
                new JSONObject().put("value", 1.5d), "e", "d", "value"));
    }
}
