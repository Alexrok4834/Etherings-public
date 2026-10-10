package xyz.etherings.player.profile;

import org.json.JSONException;
import org.json.JSONObject;

import java.time.LocalDate;

import xyz.etherings.player.economy.ErtValue;

public final class DailyActivityItem {
    private final LocalDate date;
    private final long acceptedSteps;
    private final ErtValue earnedErt;
    private final long raffleAttempts;
    private final Integer stepCap;

    private DailyActivityItem(LocalDate date, long acceptedSteps, ErtValue earnedErt,
            long raffleAttempts, Integer stepCap) {
        this.date = date;
        this.acceptedSteps = Math.max(0L, acceptedSteps);
        this.earnedErt = earnedErt;
        this.raffleAttempts = Math.max(0L, raffleAttempts);
        this.stepCap = stepCap;
    }

    public static DailyActivityItem fromJson(JSONObject value) throws JSONException {
        try {
            return new DailyActivityItem(
                    LocalDate.parse(value.getString("date")),
                    value.getLong("acceptedSteps"),
                    ErtValue.fromJson(value, "earnedErtExact", "earnedErtDisplay", "earnedErt"),
                    value.getLong("raffleAttempts"),
                    positiveInt(value, "stepCap")
            );
        } catch (RuntimeException error) {
            throw new JSONException("Activity row is invalid");
        }
    }

    public LocalDate date() {
        return date;
    }

    public long acceptedSteps() {
        return acceptedSteps;
    }

    public long earnedErt() {
        return earnedErt.wholeUnitsFloor();
    }

    public String earnedErtDisplay() {
        return earnedErt.display();
    }

    public long raffleAttempts() {
        return raffleAttempts;
    }

    public DailyActivityItem withCurrentStepCap(Integer currentStepCap) {
        if (currentStepCap != null && currentStepCap <= 0)
            throw new IllegalArgumentException("Current step cap must be positive");
        return new DailyActivityItem(date, acceptedSteps, earnedErt, raffleAttempts, currentStepCap);
    }

    public Integer stepCap() {
        return stepCap;
    }

    private static int positiveInt(JSONObject value, String key) throws JSONException {
        Object raw = value.get(key);
        if (!(raw instanceof Integer) || (Integer) raw <= 0) {
            throw new JSONException(key + " must be a positive server integer");
        }
        return (Integer) raw;
    }
}
