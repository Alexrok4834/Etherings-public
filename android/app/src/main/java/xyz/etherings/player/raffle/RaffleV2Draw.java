package xyz.etherings.player.raffle;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.time.Instant;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import xyz.etherings.player.economy.ErtValue;

public final class RaffleV2Draw {
    private final String serverTime;
    private final String drawId;
    private final String configurationVersion;
    private final String title;
    private final String description;
    private final ErtValue cost;
    private final int attemptLimit;
    private final int attemptsUsed;
    private final int attemptsRemaining;
    private final String day;
    private final String resetsAt;
    private final long totalWeight;
    private final List<RaffleV2Reward> rewards;

    private RaffleV2Draw(String serverTime, String drawId, String configurationVersion,
            String title, String description, ErtValue cost, int attemptLimit,
            int attemptsUsed, int attemptsRemaining, String day, String resetsAt,
            long totalWeight, List<RaffleV2Reward> rewards) {
        this.serverTime = serverTime;
        this.drawId = drawId;
        this.configurationVersion = configurationVersion;
        this.title = title;
        this.description = description;
        this.cost = cost;
        this.attemptLimit = attemptLimit;
        this.attemptsUsed = attemptsUsed;
        this.attemptsRemaining = attemptsRemaining;
        this.day = day;
        this.resetsAt = resetsAt;
        this.totalWeight = totalWeight;
        this.rewards = Collections.unmodifiableList(new ArrayList<>(rewards));
    }

    public static RaffleV2Draw fromJson(JSONObject root) throws JSONException {
        if (!"raffle-v2".equals(root.optString("contractVersion"))) {
            throw new JSONException("Unsupported Raffle contract version");
        }
        String serverTime = timestamp(root, "serverTime");
        JSONObject draw = root.getJSONObject("draw");
        String drawId = RaffleV2Json.uuid(draw, "drawId");
        String configurationVersion = RaffleV2Json.uuid(draw, "configurationVersion");
        String title = RaffleV2Json.text(draw, "title", 128);
        String description = draw.isNull("description") ? null : RaffleV2Json.text(draw, "description", 512);
        JSONObject costJson = draw.getJSONObject("cost");
        if (!"ERT".equals(costJson.optString("currency"))) throw new JSONException("Draw cost must use ERT");
        ErtValue cost;
        try {
            cost = ErtValue.fromExactAndDisplay(
                    RaffleV2Json.text(costJson, "amountExact", 48),
                    RaffleV2Json.text(costJson, "amountDisplay", 64));
        } catch (IllegalArgumentException error) {
            throw new JSONException(error.getMessage());
        }
        if (cost.isZero()) throw new JSONException("Draw cost must be positive");

        JSONObject attempts = draw.getJSONObject("attempts");
        int limit = boundedAttempt(attempts, "limit");
        int used = boundedAttempt(attempts, "used");
        int remaining = boundedAttempt(attempts, "remaining");
        if (limit == 0 || used > limit || remaining != limit - used) {
            throw new JSONException("Invalid Draw attempt counters");
        }
        String day = RaffleV2Json.text(attempts, "day", 10);
        try {
            if (!LocalDate.parse(day).toString().equals(day)) throw new DateTimeParseException("", day, 0);
        } catch (DateTimeParseException error) {
            throw new JSONException("Draw day must be an ISO calendar date");
        }
        String resetsAt = timestamp(attempts, "resetsAt");
        long totalWeight = RaffleV2Json.positiveLongString(draw, "totalWeight");
        JSONArray rewardJson = draw.getJSONArray("rewards");
        if (rewardJson.length() == 0) throw new JSONException("Draw must contain eligible rewards");
        List<RaffleV2Reward> rewards = new ArrayList<>();
        long sum = 0;
        for (int index = 0; index < rewardJson.length(); index++) {
            RaffleV2Reward reward = RaffleV2Reward.fromJson(rewardJson.getJSONObject(index), totalWeight);
            if (reward.segmentIndex() != index) throw new JSONException("Reward segments must be contiguous");
            try {
                sum = Math.addExact(sum, reward.weight());
            } catch (ArithmeticException error) {
                throw new JSONException("Reward weight sum overflow");
            }
            rewards.add(reward);
        }
        if (sum != totalWeight) throw new JSONException("Reward weights do not match totalWeight");
        return new RaffleV2Draw(serverTime, drawId, configurationVersion, title, description,
                cost, limit, used, remaining, day, resetsAt, totalWeight, rewards);
    }

    private static int boundedAttempt(JSONObject json, String key) throws JSONException {
        int value = RaffleV2Json.nonNegativeInt(json, key);
        if (value > 1000) throw new JSONException(key + " is outside the client safety bound");
        return value;
    }

    private static String timestamp(JSONObject json, String key) throws JSONException {
        String value = RaffleV2Json.text(json, key, 64);
        try {
            Instant.parse(value);
        } catch (DateTimeParseException error) {
            throw new JSONException(key + " must be an ISO UTC timestamp");
        }
        if (!value.endsWith("Z")) throw new JSONException(key + " must use UTC");
        return value;
    }

    public String serverTime() { return serverTime; }
    public String drawId() { return drawId; }
    public String configurationVersion() { return configurationVersion; }
    public String title() { return title; }
    public String description() { return description; }
    public ErtValue cost() { return cost; }
    public int attemptLimit() { return attemptLimit; }
    public int attemptsUsed() { return attemptsUsed; }
    public int attemptsRemaining() { return attemptsRemaining; }
    public String day() { return day; }
    public String resetsAt() { return resetsAt; }
    public long totalWeight() { return totalWeight; }
    public List<RaffleV2Reward> rewards() { return rewards; }
}
