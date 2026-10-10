package xyz.etherings.player.economy;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.json.JSONException;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class ErtValueTest {
    @Test
    public void comparesAndSubtractsWithoutDroppingFractionalUnits() {
        ErtValue balance = ErtValue.fromExact("9.999999999999999999");
        ErtValue cost = ErtValue.fromExact("10");

        assertTrue(balance.compareTo(cost) < 0);
        assertEquals("0.000000000000000001", cost.subtract(balance).exact());
        assertEquals("0.00", cost.subtract(balance).display());
        assertTrue(ErtValue.zero().isZero());
    }

    @Test
    public void readsExactValueAndVerifiesHalfUpDisplay() throws Exception {
        ErtValue value = ErtValue.fromJson(new JSONObject()
                .put("amountExact", "1.005")
                .put("amountDisplay", "1.01")
                .put("amount", 1), "amountExact", "amountDisplay", "amount");

        assertEquals("1.005", value.exact());
        assertEquals("1.01", value.display());
        assertEquals(1L, value.wholeUnitsFloor());
    }

    @Test
    public void readsLegacyIntegerWithoutBinaryFloatingPoint() throws Exception {
        ErtValue value = ErtValue.fromJson(
                new JSONObject().put("amount", 190), "amountExact", "amountDisplay", "amount"
        );

        assertEquals("190", value.exact());
        assertEquals("190.00", value.display());
    }

    @Test
    public void addsExactValuesWithoutLosingScaleEighteenRemainder() {
        ErtValue total = ErtValue.fromExact("0.13065")
                .add(ErtValue.fromExact("0.000000000000000001"));

        assertEquals("0.130650000000000001", total.exact());
        assertEquals("0.13", total.display());
    }

    @Test
    public void rejectsMalformedExactMismatchedDisplayAndFloatingFallback() {
        assertThrows(JSONException.class, () -> ErtValue.fromJson(new JSONObject()
                .put("amountExact", "1e-3"), "amountExact", "amountDisplay", "amount"));
        assertThrows(JSONException.class, () -> ErtValue.fromJson(new JSONObject()
                .put("amountExact", "1.005"), "amountExact", "amountDisplay", "amount"));
        assertThrows(JSONException.class, () -> ErtValue.fromJson(new JSONObject()
                .put("amountExact", "1.005")
                .put("amountDisplay", "1.00"), "amountExact", "amountDisplay", "amount"));
        assertThrows(JSONException.class, () -> ErtValue.fromJson(new JSONObject()
                .put("amount", 1.5d), "amountExact", "amountDisplay", "amount"));
    }
}
