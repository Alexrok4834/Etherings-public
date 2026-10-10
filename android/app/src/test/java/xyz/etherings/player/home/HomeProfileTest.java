package xyz.etherings.player.home;

import static org.junit.Assert.assertEquals;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public final class HomeProfileTest {
    @Test
    public void usesZeroEruBalanceUntilBackendTokenAccountingIsAvailable() throws Exception {
        HomeProfile profile = HomeProfile.fromJson(new JSONObject()
                .put("user", new JSONObject()
                        .put("id", "user-1")
                        .put("username", "test")
                        .put("firstName", "Test"))
                .put("balance", new JSONObject().put("ertBalance", 190))
                .put("todayStats", new JSONObject()
                        .put("acceptedSteps", 311)
                        .put("stepCap", 5000)));

        assertEquals(190L, profile.ertBalance());
        assertEquals("190.00", profile.ertBalanceDisplay());
        assertEquals("0", profile.eruBalanceExact());
        assertEquals(311, profile.acceptedStepsToday());
        assertEquals(Integer.valueOf(5000), profile.dailyStepCap());
    }

    @Test
    public void preservesExactProfileEconomyAndServerCap() throws Exception {
        HomeProfile profile = HomeProfile.fromJson(new JSONObject()
                .put("user", new JSONObject().put("id", "user-1"))
                .put("balance", new JSONObject()
                        .put("ertBalance", 6)
                        .put("ertBalanceExact", "6.5325")
                        .put("ertBalanceDisplay", "6.53")
                        .put("lifetimeEarnedErtExact", "10.005")
                        .put("lifetimeEarnedErtDisplay", "10.01")
                        .put("lifetimeSpentErtExact", "3.4725")
                        .put("lifetimeSpentErtDisplay", "3.47")
                        .put("eruBalance", JSONObject.NULL)
                        .put("eruBalanceExact", "9007199254740993")
                        .put("lifetimeEarnedEru", JSONObject.NULL)
                        .put("lifetimeEarnedEruExact", "9007199254741000")
                        .put("lifetimeSpentEru", 7)
                        .put("lifetimeSpentEruExact", "7"))
                .put("todayStats", new JSONObject()
                        .put("earnedErtExact", "1.005")
                        .put("earnedErtDisplay", "1.01")
                        .put("stepCap", 6000)
                        .put("rulesVersion", "move-to-earn-earning-v1")
                        .put("balanceConfigVersion", "move-to-earn-balance-v1")));

        assertEquals("6.5325", profile.ertBalanceExact());
        assertEquals("6.53", profile.ertBalanceDisplay());
        assertEquals("9007199254740993.00", profile.eruBalanceDisplay());
        assertEquals("9007199254741000", profile.lifetimeEarnedEruExact());
        assertEquals("7", profile.lifetimeSpentEruExact());
        assertEquals("1.01", profile.earnedErtTodayDisplay());
        assertEquals(Integer.valueOf(6000), profile.dailyStepCap());
        assertEquals("move-to-earn-earning-v1", profile.earningRulesVersion());
        assertEquals("move-to-earn-balance-v1", profile.balanceConfigVersion());

        HomeProfile cached = HomeProfile.fromJson(profile.toJson());
        assertEquals("6.5325", cached.ertBalanceExact());
        assertEquals("6.53", cached.ertBalanceDisplay());
        assertEquals("9007199254740993", cached.eruBalanceExact());
        assertEquals(JSONObject.NULL, cached.toJson().getJSONObject("balance").get("eruBalance"));
        assertEquals("9007199254740993.00",
                cached.toJson().getJSONObject("balance").getString("eruBalanceDisplay"));
        assertEquals(Integer.valueOf(6000), cached.dailyStepCap());
    }

    @Test
    public void preservesFractionalEruAndWritesOwnerCacheWithoutNumericFallback() throws Exception {
        HomeProfile profile = HomeProfile.fromJson(new JSONObject()
                .put("user", new JSONObject().put("id", "user-1"))
                .put("balance", new JSONObject()
                        .put("eruBalanceExact", "34.125")
                        .put("eruBalanceDisplay", "34.13")));

        assertEquals("34.125", profile.eruBalanceExact());
        assertEquals("34.13", profile.eruBalanceDisplay());
        JSONObject cachedBalance = profile.toJson().getJSONObject("balance");
        assertEquals(JSONObject.NULL, cachedBalance.get("eruBalance"));
        assertEquals("34.125", cachedBalance.getString("eruBalanceExact"));
        assertEquals("34.13", cachedBalance.getString("eruBalanceDisplay"));
    }

    @Test
    public void readsEruBalanceWhenBackendAddsIt() throws Exception {
        HomeProfile profile = HomeProfile.fromJson(new JSONObject()
                .put("user", new JSONObject().put("id", "user-1"))
                .put("balance", new JSONObject()
                        .put("ertBalance", 10)
                        .put("eruBalance", 7)));

        assertEquals("7", profile.eruBalanceExact());
    }

    @Test
    public void doesNotRenderJsonNullAsPartOfDisplayName() throws Exception {
        HomeProfile profile = HomeProfile.fromJson(new JSONObject()
                .put("user", new JSONObject()
                        .put("id", "user-1")
                        .put("username", "test")
                        .put("firstName", "Android Test Player")
                        .put("lastName", JSONObject.NULL)));

        assertEquals("Android Test Player", profile.displayName());
    }
}
