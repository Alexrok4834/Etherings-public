package xyz.etherings.player.home;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.fail;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public final class AlphaHomeEconomySnapshotTest {
    @Test public void keepsBackendErtAndSnapshotCapSeparateFromWalletEru() throws Exception {
        JSONObject backend = new JSONObject().put("date", "2026-09-27")
                .put("ertBalanceExact", "0.137136170212765957")
                .put("ertBalanceDisplay", "0.14").put("dailyStepCap", 6000);
        AlphaHomeEconomySnapshot profile = AlphaHomeEconomySnapshot.from(
                backend, "owner-a", "2026-09-27");
        assertEquals("owner-a", profile.ownerId());
        assertEquals("0.14", profile.ertDisplay());
        assertEquals(Integer.valueOf(6000), profile.dailyStepCap());
        assertNull(profile.eruDisplay());
        assertEquals("1.25", profile.withWalletEru("1.25").eruDisplay());
        assertNull(profile.eruDisplay());
    }

    @Test public void rejectsWrongDayOrNonExactErt() throws Exception {
        JSONObject backend = new JSONObject().put("date", "2026-09-26")
                .put("ertBalanceExact", "0.137136170212765957")
                .put("ertBalanceDisplay", "0.14").put("dailyStepCap", 6000);
        try {
            AlphaHomeEconomySnapshot.from(backend, "owner-a", "2026-09-27");
            fail("wrong day accepted");
        } catch (org.json.JSONException expected) { }
        backend.put("date", "2026-09-27").put("ertBalanceExact", 0.14);
        try {
            AlphaHomeEconomySnapshot.from(backend, "owner-a", "2026-09-27");
            fail("numeric ERT accepted");
        } catch (org.json.JSONException expected) { }
    }
}
