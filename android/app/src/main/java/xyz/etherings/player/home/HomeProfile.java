package xyz.etherings.player.home;

import org.json.JSONException;
import org.json.JSONObject;

import xyz.etherings.player.economy.ErtValue;
import xyz.etherings.player.economy.EruValue;

public final class HomeProfile {
    private final String userId;
    private final String username;
    private final String displayName;
    private final String photoUrl;
    private final ErtValue ertBalance;
    private final EruValue eruBalance;
    private final EruValue lifetimeEarnedEru;
    private final EruValue lifetimeSpentEru;
    private final ErtValue lifetimeEarnedErt;
    private final ErtValue lifetimeSpentErt;
    private final int acceptedStepsToday;
    private final ErtValue earnedErtToday;
    private final int raffleAttemptsToday;
    private final Integer dailyStepCap;
    private final String earningRulesVersion;
    private final String balanceConfigVersion;

    public HomeProfile(
            String userId,
            String username,
            String displayName,
            String photoUrl,
            ErtValue ertBalance,
            EruValue eruBalance,
            EruValue lifetimeEarnedEru,
            EruValue lifetimeSpentEru,
            ErtValue lifetimeEarnedErt,
            ErtValue lifetimeSpentErt,
            int acceptedStepsToday,
            ErtValue earnedErtToday,
            int raffleAttemptsToday,
            Integer dailyStepCap,
            String earningRulesVersion,
            String balanceConfigVersion
    ) {
        this.userId = userId == null ? "" : userId;
        this.username = username == null ? "" : username;
        this.displayName = displayName == null ? "" : displayName;
        this.photoUrl = photoUrl;
        this.ertBalance = ertBalance == null ? ErtValue.zero() : ertBalance;
        this.eruBalance = eruBalance == null ? EruValue.zero() : eruBalance;
        this.lifetimeEarnedEru = lifetimeEarnedEru == null ? EruValue.zero() : lifetimeEarnedEru;
        this.lifetimeSpentEru = lifetimeSpentEru == null ? EruValue.zero() : lifetimeSpentEru;
        this.lifetimeEarnedErt = lifetimeEarnedErt == null ? ErtValue.zero() : lifetimeEarnedErt;
        this.lifetimeSpentErt = lifetimeSpentErt == null ? ErtValue.zero() : lifetimeSpentErt;
        this.acceptedStepsToday = acceptedStepsToday;
        this.earnedErtToday = earnedErtToday == null ? ErtValue.zero() : earnedErtToday;
        this.raffleAttemptsToday = raffleAttemptsToday;
        this.dailyStepCap = dailyStepCap;
        this.earningRulesVersion = earningRulesVersion;
        this.balanceConfigVersion = balanceConfigVersion;
    }

    public static HomeProfile fromJson(JSONObject profile) throws JSONException {
        JSONObject user = profile.optJSONObject("user");
        JSONObject balance = profile.optJSONObject("balance");
        JSONObject todayStats = profile.optJSONObject("todayStats");

        String username = optionalString(user, "username");
        String firstName = optionalString(user, "firstName");
        String lastName = optionalString(user, "lastName");
        String displayName = joinDisplayName(firstName, lastName, username);
        String photoUrl = optionalNullableString(user, "photoUrl");

        return new HomeProfile(
                user == null ? "" : user.optString("id", ""),
                username,
                displayName,
                photoUrl,
                ErtValue.fromJson(balance, "ertBalanceExact", "ertBalanceDisplay", "ertBalance"),
                EruValue.fromJson(balance, "eruBalanceExact", "eruBalanceDisplay", "eruBalance"),
                EruValue.fromJson(balance, "lifetimeEarnedEruExact", "lifetimeEarnedEruDisplay", "lifetimeEarnedEru"),
                EruValue.fromJson(balance, "lifetimeSpentEruExact", "lifetimeSpentEruDisplay", "lifetimeSpentEru"),
                ErtValue.fromJson(balance, "lifetimeEarnedErtExact", "lifetimeEarnedErtDisplay", "lifetimeEarnedErt"),
                ErtValue.fromJson(balance, "lifetimeSpentErtExact", "lifetimeSpentErtDisplay", "lifetimeSpentErt"),
                optInt(todayStats, "acceptedSteps"),
                ErtValue.fromJson(todayStats, "earnedErtExact", "earnedErtDisplay", "earnedErt"),
                optInt(todayStats, "raffleAttempts"),
                optionalPositiveInt(todayStats, "stepCap"),
                optionalNullableString(todayStats, "rulesVersion"),
                optionalNullableString(todayStats, "balanceConfigVersion")
        );
    }

    public static HomeProfile offlineOwner(String ownerId) {
        return new HomeProfile(
                ownerId, "", "", null, ErtValue.zero(), EruValue.zero(), EruValue.zero(), EruValue.zero(),
                ErtValue.zero(), ErtValue.zero(),
                0, ErtValue.zero(), 0, null, null, null
        );
    }

    public JSONObject toJson() {
        try {
            JSONObject user = new JSONObject()
                    .put("id", userId)
                    .put("username", username)
                    .put("firstName", displayName)
                    .put("lastName", JSONObject.NULL)
                    .put("photoUrl", photoUrl == null ? JSONObject.NULL : photoUrl);
            JSONObject balance = new JSONObject();
            eruBalance.writeTo(balance, "eruBalanceExact", "eruBalanceDisplay", "eruBalance");
            lifetimeEarnedEru.writeTo(balance, "lifetimeEarnedEruExact", "lifetimeEarnedEruDisplay", "lifetimeEarnedEru");
            lifetimeSpentEru.writeTo(balance, "lifetimeSpentEruExact", "lifetimeSpentEruDisplay", "lifetimeSpentEru");
            ertBalance.writeTo(balance, "ertBalanceExact", "ertBalanceDisplay", "ertBalance");
            lifetimeEarnedErt.writeTo(
                    balance, "lifetimeEarnedErtExact", "lifetimeEarnedErtDisplay", "lifetimeEarnedErt"
            );
            lifetimeSpentErt.writeTo(
                    balance, "lifetimeSpentErtExact", "lifetimeSpentErtDisplay", "lifetimeSpentErt"
            );
            JSONObject todayStats = new JSONObject()
                    .put("acceptedSteps", acceptedStepsToday)
                    .put("raffleAttempts", raffleAttemptsToday);
            earnedErtToday.writeTo(todayStats, "earnedErtExact", "earnedErtDisplay", "earnedErt");
            if (dailyStepCap != null) todayStats.put("stepCap", dailyStepCap);
            if (earningRulesVersion != null) todayStats.put("rulesVersion", earningRulesVersion);
            if (balanceConfigVersion != null) todayStats.put("balanceConfigVersion", balanceConfigVersion);
            return new JSONObject()
                    .put("user", user)
                    .put("balance", balance)
                    .put("todayStats", todayStats);
        } catch (org.json.JSONException error) {
            throw new IllegalStateException("Could not encode home profile", error);
        }
    }

    public String username() {
        return username;
    }

    public String userId() {
        return userId;
    }

    public String displayName() {
        return displayName;
    }

    public String photoUrl() {
        return photoUrl;
    }

    public long ertBalance() {
        return ertBalance.wholeUnitsFloor();
    }

    public String ertBalanceExact() {
        return ertBalance.exact();
    }

    public String ertBalanceDisplay() {
        return ertBalance.display();
    }

    public String eruBalanceExact() {
        return eruBalance.exact();
    }

    public String eruBalanceDisplay() {
        return eruBalance.display();
    }

    public String lifetimeEarnedEruExact() {
        return lifetimeEarnedEru.exact();
    }

    public String lifetimeSpentEruExact() {
        return lifetimeSpentEru.exact();
    }

    public long lifetimeEarnedErt() {
        return lifetimeEarnedErt.wholeUnitsFloor();
    }

    public long lifetimeSpentErt() {
        return lifetimeSpentErt.wholeUnitsFloor();
    }

    public int acceptedStepsToday() {
        return acceptedStepsToday;
    }

    public long earnedErtToday() {
        return earnedErtToday.wholeUnitsFloor();
    }

    public String earnedErtTodayDisplay() {
        return earnedErtToday.display();
    }

    public Integer dailyStepCap() {
        return dailyStepCap;
    }

    public String earningRulesVersion() {
        return earningRulesVersion;
    }

    public String balanceConfigVersion() {
        return balanceConfigVersion;
    }

    public int raffleAttemptsToday() {
        return raffleAttemptsToday;
    }

    private static String joinDisplayName(String firstName, String lastName, String fallback) {
        String fullName = ((firstName == null ? "" : firstName.trim()) + " " + (lastName == null ? "" : lastName.trim())).trim();
        if (!fullName.isEmpty()) {
            return fullName;
        }

        return fallback == null ? "" : fallback.trim();
    }

    private static int optInt(JSONObject object, String key) {
        return object == null ? 0 : object.optInt(key, 0);
    }

    private static String optionalString(JSONObject object, String key) {
        String value = optionalNullableString(object, key);
        return value == null ? "" : value;
    }

    private static String optionalNullableString(JSONObject object, String key) {
        if (object == null || object.isNull(key)) {
            return null;
        }
        String value = object.optString(key, "").trim();
        return value.isEmpty() || "null".equalsIgnoreCase(value) ? null : value;
    }

    private static Integer optionalPositiveInt(JSONObject object, String key) {
        if (object == null || object.isNull(key)) return null;
        Object value = object.opt(key);
        if (!(value instanceof Integer) || (Integer) value <= 0) {
            throw new IllegalArgumentException(key + " must be a positive server integer");
        }
        return (Integer) value;
    }
}
